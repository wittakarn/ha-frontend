import type { PropertyValues } from "lit";
import { css, html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators";
import { isComponentLoaded } from "../../common/config/is_component_loaded";
import { computeStateDomain } from "../../common/entity/compute_state_domain";
import { throttle } from "../../common/util/throttle";
import "../../components/ha-circular-progress";
import type { LogbookEntry, LogbookStreamMessage } from "../../data/logbook";
import { subscribeLogbook } from "../../data/logbook";
import type { TraceContexts } from "../../data/trace";
import { loadTraceContexts } from "../../data/trace";
import { fetchUsers } from "../../data/user";
import type { HomeAssistant } from "../../types";
import "./ha-logbook-renderer";

interface LogbookTimePeriod {
  now: Date;
  startTime: Date;
  endTime: Date;
  purgeBeforePythonTime: number | undefined;
}

const findStartOfRecentTime = (now: Date, recentTime: number) =>
  new Date(now.getTime() - recentTime * 1000).getTime() / 1000;

const idsChanged = (oldIds?: string[], newIds?: string[]) => {
  if (oldIds === undefined && newIds === undefined) {
    return false;
  }
  return (
    !oldIds ||
    !newIds ||
    oldIds.length !== newIds.length ||
    oldIds.some((val) => !newIds.includes(val)) ||
    newIds.some((val) => !oldIds.includes(val))
  );
};

@customElement("ha-logbook")
export class HaLogbook extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ attribute: false }) public time!:
    | { range: [Date, Date] }
    | {
        // Seconds
        recent: number;
      };

  @property({ attribute: false }) public entityIds?: string[];

  @property({ attribute: false }) public deviceIds?: string[];

  @property({ type: Boolean }) public narrow = false;

  @property({ type: Boolean, reflect: true }) public virtualize = false;

  @property({ type: Boolean, attribute: "no-icon" }) public noIcon = false;

  @property({ type: Boolean, attribute: "no-name" }) public noName = false;

  @property({ type: Boolean, attribute: "show-indicator" })
  public showIndicator = false;

  @property({ type: Boolean, attribute: "relative-time" })
  public relativeTime = false;

  @property({ attribute: "show-more-link", type: Boolean })
  public showMoreLink = true;

  @state() private _logbookEntries?: LogbookEntry[];

  @state() private _traceContexts: TraceContexts = {};

  @state() private _userIdToName = {};

  @state() private _error?: string;

  private _subscribed?: (() => Promise<void>) | undefined;

  private _liveUpdatesEnabled = true;

  private _pendingStreamMessages: LogbookStreamMessage[] = [];

  private _throttleGetLogbookEntries = throttle(
    () => this._getLogBookData(),
    1000
  );

  protected render() {
    if (!isComponentLoaded(this.hass, "logbook")) {
      return nothing;
    }

    if (this._error) {
      return html`<div class="no-entries">
        ${`${this.hass.localize("ui.components.logbook.retrieval_error")}: ${
          this._error
        }`}
      </div>`;
    }

    if (this._logbookEntries === undefined) {
      return html`
        <div class="progress-wrapper">
          <ha-circular-progress indeterminate></ha-circular-progress>
        </div>
      `;
    }

    if (this._logbookEntries.length === 0) {
      return html`<div class="no-entries">
        ${this.hass.localize("ui.components.logbook.entries_not_found")}
      </div>`;
    }

    return html`
      <ha-logbook-renderer
        .hass=${this.hass}
        .narrow=${this.narrow}
        .virtualize=${this.virtualize}
        .noIcon=${this.noIcon}
        .noName=${this.noName}
        .showIndicator=${this.showIndicator}
        .relativeTime=${this.relativeTime}
        .entries=${this._logbookEntries}
        .traceContexts=${this._traceContexts}
        .userIdToName=${this._userIdToName}
        @hass-logbook-live=${this._handleLogbookLive}
      ></ha-logbook-renderer>
    `;
  }

  public async refresh(force = false) {
    if (!force && (this._subscribed || this._logbookEntries === undefined)) {
      return;
    }

    this._throttleGetLogbookEntries.cancel();
    this._updateTraceContexts.cancel();
    this._updateUsers.cancel();
    await this._unsubscribeSetLoading();

    this._liveUpdatesEnabled = true;

    if (force) {
      this._getLogBookData();
    } else {
      this._throttleGetLogbookEntries();
    }
  }

  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (changedProps.size !== 1 || !changedProps.has("hass")) {
      return true;
    }
    // We only respond to hass changes if the translations changed
    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;
    return !oldHass || oldHass.localize !== this.hass.localize;
  }

  protected willUpdate(changedProps: PropertyValues): void {
    let changed = changedProps.has("time");

    for (const key of ["entityIds", "deviceIds"]) {
      if (!changedProps.has(key)) {
        continue;
      }

      const oldValue = changedProps.get(key) as string[] | undefined;
      const curValue = this[key] as string[] | undefined;

      // If they make the filter more specific we want
      // to change the subscription since it will reduce
      // the overhead on the backend as the event stream
      // can be a firehose for all state events.
      if (idsChanged(oldValue, curValue)) {
        changed = true;
        break;
      }
    }

    if (changed) {
      this.refresh(true);
    }
  }

  private _handleLogbookLive(ev: CustomEvent) {
    if (ev.detail.enable && !this._liveUpdatesEnabled) {
      // Process everything we queued up while we were scrolled down
      this._pendingStreamMessages.forEach((msg) =>
        this._processStreamMessage(msg)
      );
      this._pendingStreamMessages = [];
    }
    this._liveUpdatesEnabled = ev.detail.enable;
  }

  private get _filterAlwaysEmptyResults(): boolean {
    const entityIds = this.entityIds;
    const deviceIds = this.deviceIds;

    // If all specified filters are empty lists, we can return an empty list.
    return (
      Boolean(entityIds || deviceIds) &&
      (!entityIds || entityIds.length === 0) &&
      (!deviceIds || deviceIds.length === 0)
    );
  }

  private async _unsubscribe(): Promise<void> {
    if (this._subscribed) {
      try {
        await this._subscribed();
        this._subscribed = undefined;
        this._pendingStreamMessages = [];
      } catch (err: any) {
        // eslint-disable-next-line
        console.error("Error unsubscribing:", err);
      }
    }
  }

  public connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      // Ensure clean state before subscribing
      this._subscribeLogbookPeriod(this._calculateLogbookPeriod());
    }
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeSetLoading();
  }

  /** Unsubscribe because we are unloading
   * or about to resubscribe.
   * Setting this._logbookEntries to undefined
   * will put the page in a loading state.
   */
  private async _unsubscribeSetLoading() {
    await this._unsubscribe();
    this._logbookEntries = undefined;
    this._pendingStreamMessages = [];
  }

  /** Unsubscribe because there are no results.
   * Setting this._logbookEntries to an empty
   * list will show a no results message.
   */
  private async _unsubscribeNoResults() {
    await this._unsubscribe();
    this._logbookEntries = [];
    this._pendingStreamMessages = [];
  }

  private _calculateLogbookPeriod() {
    const now = new Date();
    if ("range" in this.time) {
      return {
        now: now,
        startTime: this.time.range[0],
        endTime: this.time.range[1],
        purgeBeforePythonTime: undefined,
      } as LogbookTimePeriod;
    }
    if ("recent" in this.time) {
      const purgeBeforePythonTime = findStartOfRecentTime(
        now,
        this.time.recent
      );
      return {
        now: now,
        startTime: new Date(purgeBeforePythonTime * 1000),
        // end streaming one year from now
        endTime: new Date(now.getTime() + 86400 * 365 * 1000),
        purgeBeforePythonTime: findStartOfRecentTime(now, this.time.recent),
      } as LogbookTimePeriod;
    }
    throw new Error("Unexpected time specified");
  }

  private async _subscribeLogbookPeriod(
    logbookPeriod: LogbookTimePeriod
  ): Promise<void> {
    if (this._subscribed) {
      return;
    }
    try {
      this._subscribed = await subscribeLogbook(
        this.hass,
        (streamMessage) => {
          // "recent" means start time is a sliding window
          // so we need to calculate an expireTime to
          // purge old events
          if (!this._subscribed) {
            // Message came in before we had a chance to unload
            return;
          }
          this._processOrQueueStreamMessage(streamMessage);
        },
        logbookPeriod.startTime.toISOString(),
        logbookPeriod.endTime.toISOString(),
        this.entityIds,
        this.deviceIds
      );
    } catch (err: any) {
      this._subscribed = undefined;
      this._error = err;
    }
  }

  private async _getLogBookData() {
    this._error = undefined;

    if (this._filterAlwaysEmptyResults) {
      await this._unsubscribeNoResults();
      return;
    }

    const logbookPeriod = this._calculateLogbookPeriod();

    if (logbookPeriod.startTime > logbookPeriod.now) {
      // Time Travel not yet invented
      await this._unsubscribeNoResults();
      return;
    }

    this._updateUsers();
    if (this.hass.user?.is_admin) {
      this._updateTraceContexts();
    }

    this._subscribeLogbookPeriod(logbookPeriod);
  }

  private _nonExpiredRecords = (purgeBeforePythonTime: number | undefined) =>
    !this._logbookEntries
      ? []
      : purgeBeforePythonTime
        ? this._logbookEntries.filter(
            (entry) => entry.when > purgeBeforePythonTime!
          )
        : this._logbookEntries;

  private _processOrQueueStreamMessage = (
    streamMessage: LogbookStreamMessage
  ) => {
    if (this._liveUpdatesEnabled) {
      this._processStreamMessage(streamMessage);
      return;
    }
    this._pendingStreamMessages.push(streamMessage);
  };

  private _processStreamMessage = (streamMessage: LogbookStreamMessage) => {
    const purgeBeforePythonTime =
      "recent" in this.time
        ? findStartOfRecentTime(new Date(), this.time.recent)
        : undefined;
    // Put newest ones on top. Reverse works in-place so
    // make a copy first.
    const newEntries = [...streamMessage.events].reverse();
    if (!this._logbookEntries || !this._logbookEntries.length) {
      this._logbookEntries = newEntries;
      return;
    }
    if (!newEntries.length) {
      // Empty messages are still sent to
      // indicate no more historical events
      return;
    }
    const nonExpiredRecords = this._nonExpiredRecords(purgeBeforePythonTime);

    // Entries are sorted in descending order with newest first.
    if (!nonExpiredRecords.length) {
      // We have no records left, so we can just replace the list
      this._logbookEntries = newEntries;
    } else if (
      newEntries[newEntries.length - 1].when > // oldest new entry
      nonExpiredRecords[0].when // newest old entry
    ) {
      // The new records are newer than the old records
      // append the old records to the end of the new records
      this._logbookEntries = newEntries.concat(nonExpiredRecords);
    } else if (
      nonExpiredRecords[nonExpiredRecords.length - 1].when > // oldest old entry
      newEntries[0].when // newest new entry
    ) {
      // The new records are older than the old records
      // append the new records to the end of the old records
      this._logbookEntries = nonExpiredRecords.concat(newEntries);
    } else {
      // The new records are in the middle of the old records
      // so we need to re-sort them
      this._logbookEntries = nonExpiredRecords
        .concat(newEntries)
        .sort((a, b) => b.when - a.when);
    }
  };

  private _updateTraceContexts = throttle(async () => {
    this._traceContexts = await loadTraceContexts(this.hass);
  }, 60000);

  private _updateUsers = throttle(async () => {
    const userIdToName = {};

    // Start loading users
    const userProm = this.hass.user?.is_admin && fetchUsers(this.hass);

    // Process persons
    for (const entity of Object.values(this.hass.states)) {
      if (
        entity.attributes.user_id &&
        computeStateDomain(entity) === "person"
      ) {
        userIdToName[entity.attributes.user_id] =
          entity.attributes.friendly_name;
      }
    }

    // Process users
    if (userProm) {
      const users = await userProm;
      for (const user of users) {
        if (!(user.id in userIdToName)) {
          userIdToName[user.id] = user.name;
        }
      }
    }

    this._userIdToName = userIdToName;
  }, 60000);

  static get styles() {
    return [
      css`
        :host {
          display: block;
        }

        :host([virtualize]) {
          height: 100%;
        }

        .no-entries {
          text-align: center;
          padding: 16px;
          color: var(--secondary-text-color);
        }

        .progress-wrapper {
          display: flex;
          justify-content: center;
          height: 100%;
          align-items: center;
        }
      `,
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-logbook": HaLogbook;
  }
}
