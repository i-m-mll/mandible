/** The native session-task envelope, admitted only with producer provenance. */
export function claudeTaskNotification(content:string):{summary:string;result:string}|null {
  const match=/^\s*<task-notification>\s*<task-id>[^<>]+<\/task-id>\s*<tool-use-id>[^<>]+<\/tool-use-id>\s*<output-file>[^<>]*<\/output-file>\s*<status>[^<>]+<\/status>\s*<summary>([\s\S]*?)<\/summary>\s*(?:<note>[\s\S]*?<\/note>\s*)?<result>([\s\S]*)<\/result>\s*(?:<usage>[\s\S]*?<\/usage>\s*)?<\/task-notification>\s*$/.exec(content);
  return match && match[1].trim() ? {summary:match[1].trim(),result:match[2].trim()} : null;
}
