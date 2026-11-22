const style = `<style>
  #mandible-startup-frame {
    --frame-chrome: var(--surface-chrome, #222);
    --frame-main: var(--surface-main, #181818);
    --frame-line: var(--border-muted, #373737);
    color-scheme: light dark;
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    grid-template: var(--app-frame-header-height, 42px) 1fr / var(--app-rail-width, 44.8px) 1fr;
    background: var(--frame-chrome);
  }
  #mandible-startup-frame[hidden] { display: none; }
  #mandible-startup-frame:not([hidden]) ~ #app { visibility: hidden; }
  #mandible-startup-frame > :first-child { grid-column: 1 / -1; }
  #mandible-startup-frame > :nth-child(2) { padding-top: 10px; }
  #mandible-startup-frame > :last-child {
    border: solid var(--frame-line);
    border-width: 1px 0 0 1px;
    border-top-left-radius: var(--radius-chat-surface, 18px);
    background: var(--frame-main);
  }
  #mandible-startup-frame i {
    display: block;
    margin: 11px auto 23px;
    width: 14px;
    height: 14px;
    border-radius: 5px;
    background: var(--frame-line);
  }
  #mandible-startup-frame > :first-child > i { margin: 14px 0 0 19px; }
  .tauri-window #mandible-startup-frame > :first-child > i { margin-inline-start: 78px; }
  @media (prefers-color-scheme: light) {
    #mandible-startup-frame {
      --frame-chrome: var(--surface-chrome, #efefef);
      --frame-main: var(--surface-main, #fff);
      --frame-line: var(--border-muted, #ddd);
    }
  }
</style>`;

const markup = `<div id="mandible-startup-frame" aria-hidden="true">
  <div data-tauri-drag-region data-native-drag-boundary><i></i></div>
  <div><i></i><i></i><i></i><i></i></div>
  <div></div>
</div>`;

export function injectStartupFrame(html: string): string {
  return html
    .replace("<!-- mandible-startup-frame-style -->", () => style)
    .replace("<!-- mandible-startup-frame -->", () => markup);
}
