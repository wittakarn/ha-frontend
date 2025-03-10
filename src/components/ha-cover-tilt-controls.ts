import { mdiArrowBottomLeft, mdiArrowTopRight, mdiStop } from "@mdi/js";
import { css, html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators";
import { classMap } from "lit/directives/class-map";
import { supportsFeature } from "../common/entity/supports-feature";
import type { CoverEntity } from "../data/cover";
import {
  canCloseTilt,
  canOpenTilt,
  canStopTilt,
  CoverEntityFeature,
} from "../data/cover";
import type { HomeAssistant } from "../types";
import "./ha-icon-button";

@customElement("ha-cover-tilt-controls")
class HaCoverTiltControls extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ attribute: false }) stateObj!: CoverEntity;

  protected render() {
    if (!this.stateObj) {
      return nothing;
    }

    return html` <ha-icon-button
        class=${classMap({
          invisible: !supportsFeature(
            this.stateObj,
            CoverEntityFeature.OPEN_TILT
          ),
        })}
        .label=${this.hass.localize("ui.card.cover.open_tilt_cover")}
        .path=${mdiArrowTopRight}
        @click=${this._onOpenTiltTap}
        .disabled=${!canOpenTilt(this.stateObj)}
      ></ha-icon-button>
      <ha-icon-button
        class=${classMap({
          invisible: !supportsFeature(
            this.stateObj,
            CoverEntityFeature.STOP_TILT
          ),
        })}
        .label=${this.hass.localize("ui.card.cover.stop_cover")}
        .path=${mdiStop}
        @click=${this._onStopTiltTap}
        .disabled=${!canStopTilt(this.stateObj)}
      ></ha-icon-button>
      <ha-icon-button
        class=${classMap({
          invisible: !supportsFeature(
            this.stateObj,
            CoverEntityFeature.CLOSE_TILT
          ),
        })}
        .label=${this.hass.localize("ui.card.cover.close_tilt_cover")}
        .path=${mdiArrowBottomLeft}
        @click=${this._onCloseTiltTap}
        .disabled=${!canCloseTilt(this.stateObj)}
      ></ha-icon-button>`;
  }

  private _onOpenTiltTap(ev): void {
    ev.stopPropagation();
    this.hass.callService("cover", "open_cover_tilt", {
      entity_id: this.stateObj.entity_id,
    });
  }

  private _onCloseTiltTap(ev): void {
    ev.stopPropagation();
    this.hass.callService("cover", "close_cover_tilt", {
      entity_id: this.stateObj.entity_id,
    });
  }

  private _onStopTiltTap(ev): void {
    ev.stopPropagation();
    this.hass.callService("cover", "stop_cover_tilt", {
      entity_id: this.stateObj.entity_id,
    });
  }

  static styles = css`
    :host {
      white-space: nowrap;
    }
    .invisible {
      visibility: hidden !important;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-cover-tilt-controls": HaCoverTiltControls;
  }
}
