import { createChannelClient } from "../../src/channel/client.js";
import { request } from "../../channel-server/transport.js";
export { ambientHeaders, channelTransportHeaders, MandibleClientError } from "../../channel-server/transport.js";
export const { checkInbox, checkInboxGlobal, fetchUndeliveredAuthResults, markAuthDelivered, getIssues, getWorkUnits, patchWorkUnit, getAuthQueue, submitAuth, registerSession, sessionOwnerPid, recordChannelToolCall, updateSession } = createChannelClient(request, process.env.MANDIBLE_MANAGED_APP ?? "claude");
