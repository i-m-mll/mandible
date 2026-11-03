import { ActivityPayloadBox } from './ActivityPayloadBox';
import { OverflowFade } from './OverflowFade';

export function ReasoningDetails({ parts }: { parts: readonly string[] }): JSX.Element {
  return <ActivityPayloadBox><OverflowFade lines={10}><pre className="reasoning-details">{parts.join('\n\n')}</pre></OverflowFade></ActivityPayloadBox>;
}
