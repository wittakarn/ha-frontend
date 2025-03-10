import { mdiPower, mdiPowerOff } from "@mdi/js";
import type { HassEntity } from "home-assistant-js-websocket";
import type { CSSResultGroup } from "lit";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators";
import "../../../components/ha-attributes";
import "../../../state-control/ha-state-control-toggle";
import type { HomeAssistant } from "../../../types";
import "../components/ha-more-info-state-header";
import { moreInfoControlStyle } from "../components/more-info-control-style";

@customElement("more-info-switch")
class MoreInfoSwitch extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ attribute: false }) public stateObj?: HassEntity;

  protected render() {
    if (!this.hass || !this.stateObj) {
      return nothing;
    }

    return html`
      <ha-more-info-state-header
        .hass=${this.hass}
        .stateObj=${this.stateObj}
      ></ha-more-info-state-header>
      <div class="controls">
        <ha-state-control-toggle
          .stateObj=${this.stateObj}
          .hass=${this.hass}
          .iconPathOn=${mdiPower}
          .iconPathOff=${mdiPowerOff}
        ></ha-state-control-toggle>
      </div>
      <ha-attributes
        .hass=${this.hass}
        .stateObj=${this.stateObj}
      ></ha-attributes>
    `;
  }

  static get styles(): CSSResultGroup {
    return moreInfoControlStyle;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "more-info-switch": MoreInfoSwitch;
  }
}
