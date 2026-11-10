import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import type { DurableHost } from "../../src/agents/durable/host";
import { replayResponse } from "../backend/fixtures/model_response/replay";

export async function seedModelResponse(
  request: Request,
  durable: DurableHost,
  models: ReturnType<typeof createModels>,
  create: (cid: string, title: string, model: string) => Promise<void>,
) {
  const body = (await request.json()) as {
    agent?: string;
    downgrade: boolean;
    run?: boolean;
  };
  const cid = body.agent ?? `model-response-${crypto.randomUUID().slice(0, 8)}`;
  let selector = "fauxfast/faux-1";
  if (body.run) {
    const faux = fauxProvider({ provider: cid, tokensPerSecond: 20_000 });
    const catalog = faux.provider.getModels();
    const served = { ...catalog[0]!, id: "faux-served", name: "Served model" };
    faux.setResponses([
      { ...fauxAssistantMessage("NORMAL_MODEL_OK"), responseModel: served.id },
    ]);
    models.setProvider({
      ...faux.provider,
      getModels: () => [...catalog, served],
    });
    selector = `${cid}/${catalog[0]!.id}`;
  }
  if (!body.agent) await create(cid, "Model response", selector);
  if (body.run) return { agent: cid };
  const { conversation } = await durable.open(cid);
  const message = await replayResponse(body.downgrade);
  const entry = await conversation.commit(
    (tx) =>
      tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        model: [message],
      }),
    BACKGROUND_CONTEXT,
  );
  return { agent: cid, entryId: entry.id };
}
