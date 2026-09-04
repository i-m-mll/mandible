import type { ChatBottomShelfPreference } from '../../../src/contracts';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { MonitorIcon } from '../components/icons/TabIcons';
import { SessionOverviewView } from '../views/session-overview';
import { IssueReferenceDetail } from '../views/spaces/SpaceReferenceDetailPanel';
import type { ChatPreviewTarget } from './ChatEntityLinkBoundary';

function SearchIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

export function ChatBottomShelf({
  preference,
  preferenceReady,
  preferenceError,
  providerSessionId,
  conversationId,
  previewTarget,
  onPreferenceChange,
  onClearPreview,
}: {
  preference: ChatBottomShelfPreference;
  preferenceReady: boolean;
  preferenceError: string | null;
  providerSessionId: string | null;
  conversationId: string;
  previewTarget: ChatPreviewTarget | null;
  onPreferenceChange: (next: ChatBottomShelfPreference) => void;
  onClearPreview: () => void;
}): JSX.Element {
  const selectTab = (tab: ChatBottomShelfPreference['tab']) => {
    onPreferenceChange({ ...preference, tab });
  };
  const tabId = `chat-shelf-${preference.tab}`;
  return (
    <DetailPaneShell
      as="section"
      variant="compact"
      className="chat-bottom-shelf"
      header={(
        <div className="chat-bottom-shelf__tabs" role="tablist" aria-label="Chat footer views">
          <button
            type="button"
            role="tab"
            id="chat-shelf-tab-overview"
            aria-controls="chat-shelf-panel-overview"
            aria-selected={preference.tab === 'overview'}
            tabIndex={preference.tab === 'overview' ? 0 : -1}
            onClick={() => selectTab('overview')}
          >
            <MonitorIcon />
            Session Overview
          </button>
          <button
            type="button"
            role="tab"
            id="chat-shelf-tab-preview"
            aria-controls="chat-shelf-panel-preview"
            aria-selected={preference.tab === 'preview'}
            tabIndex={preference.tab === 'preview' ? 0 : -1}
            onClick={() => selectTab('preview')}
          >
            <SearchIcon />
            Preview
          </button>
        </div>
      )}
      footer={{
        ariaLabel: 'Chat footer preferences',
        content: (
          <div className="chat-bottom-shelf__footer">
            <fieldset disabled={!preferenceReady}>
              <legend>Plain issue-link click</legend>
              <label>
                <input
                  type="radio"
                  name="chat-link-action"
                  checked={preference.clickAction === 'preview'}
                  onChange={() => onPreferenceChange({ ...preference, clickAction: 'preview' })}
                />
                Preview in footer
              </label>
              <label>
                <input
                  type="radio"
                  name="chat-link-action"
                  checked={preference.clickAction === 'open'}
                  onChange={() => onPreferenceChange({ ...preference, clickAction: 'open' })}
                />
                Open normally
              </label>
            </fieldset>
            {previewTarget ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={onClearPreview}
              >
                Clear preview
              </button>
            ) : null}
            {preferenceError ? <span role="status" className="chat-bottom-shelf__error">{preferenceError}</span> : null}
          </div>
        ),
      }}
    >
      <div
        id={`chat-shelf-panel-${preference.tab}`}
        className="chat-bottom-shelf__panel"
        role="tabpanel"
        aria-labelledby={`chat-shelf-tab-${preference.tab}`}
        data-active-tab={tabId}
      >
        {preference.tab === 'overview' ? (
          providerSessionId ? (
            <SessionOverviewView
              key={conversationId}
              initialSessionId={null}
              agentBinding={providerSessionId}
              embedded
            />
          ) : (
            <div className="chat-bottom-shelf__empty">No Session Overview is available for this conversation.</div>
          )
        ) : previewTarget ? (
          <IssueReferenceDetail issueRef={previewTarget.ref} repoId={previewTarget.repoId} />
        ) : (
          <div className="chat-bottom-shelf__empty">Nothing selected for preview.</div>
        )}
      </div>
    </DetailPaneShell>
  );
}
