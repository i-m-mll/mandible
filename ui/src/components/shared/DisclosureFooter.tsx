import { Icon } from '../icons/Icon';

export function DisclosureFooter({expanded,onExpandedChange}:{
  expanded:boolean; onExpandedChange:(expanded:boolean,trigger:HTMLButtonElement)=>void;
}):JSX.Element {
  return <button type="button" className="reading-disclosure-footer" aria-expanded={expanded}
    onClick={event=>{event.stopPropagation();onExpandedChange(!expanded,event.currentTarget);}}>
    <span className="reading-disclosure-footer__label">{expanded?'Show less':'Show more'}</span><Icon name={expanded?'disclosureLess':'disclosureMore'} size={14}/>
  </button>;
}
