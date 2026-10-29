import type { Db } from "../db.js";
import { ConversationSourceStore } from "./source-store.js";

/** Canonical publication facts; physical bytes still require a verified lease. */
export function readConversationSourceGenerations(db:Db,conversationIds:readonly string[]):Map<string,string> {
  return db.transaction(()=>{
    const store=new ConversationSourceStore(db);
    const sources=store.resolveConversations(conversationIds);
    const versions=store.resolveVersions([...sources.values()].flatMap(source=>source.currentVersionId?[source.currentVersionId]:[]));
    const aliases=store.listAliasesForSources([...sources.values()].map(source=>source.sourceId));
    return new Map(conversationIds.map(id=>{
      const source=sources.get(id)??null;
      return [id,JSON.stringify({source,version:source?.currentVersionId?versions.get(source.currentVersionId)??null:null,aliases:source?(aliases.get(source.sourceId)??[]).sort((left,right)=>left.id.localeCompare(right.id)):[]})];
    }));
  })();
}

export function readConversationSourceGeneration(db:Db,conversationId:string):string {
  return readConversationSourceGenerations(db,[conversationId]).get(conversationId)!;
}
