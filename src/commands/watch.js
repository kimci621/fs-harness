import { pollOnce, formatEvents } from '../watch.js';
import { postMattermost } from '../notify.js';

// fsh watch — один опрос: что изменилось с прошлого раза, что из этого важно.
// Действия не запускает (PLAN § «чего в v1 не делаем», п. 6): только смотрит и уведомляет.
export async function cmdWatch(ctx, { json, asObject } = {}) {
  const { first, events, kept, verdict, triageError, snapshot } = await pollOnce({
    g: ctx.g,
    repo: ctx.repo,
    cfg: ctx.cfg,
  });

  const webhook = ctx.cfg?.mattermost?.webhook;
  let notified = false;
  if (webhook && kept.length) {
    try {
      await postMattermost(webhook, `**${ctx.repo}**\n${formatEvents(kept, { verdict })}`);
      notified = true;
    } catch (err) {
      console.error(`⚠ Уведомление не ушло: ${err.message}`);
    }
  }

  const result = {
    ok: true,
    first,
    mrs: snapshot.mrs.length,
    events: events.map(({ finding, ...e }) => e),
    kept: kept.map(({ finding, ...e }) => e),
    triage: verdict ? { decision: verdict.decision, summary: verdict.summary, cost: verdict.meta?.cost ?? 0 } : null,
    triage_error: triageError,
    notified,
  };
  if (asObject) return result;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (first) {
    console.log(`Первый снимок ${ctx.repo}: ${snapshot.mrs.length} открытых MR. Сравнивать пока не с чем.`);
    return result;
  }
  console.log(`${ctx.repo}: событий с прошлого опроса ${events.length}, важных ${kept.length}.`);
  if (triageError) console.log(`⚠ Триаж не сработал (${triageError}) — показываю всё.`);
  if (events.length) console.log(formatEvents(kept, { verdict }));
  if (notified) console.log('Отправлено в Mattermost.');
  return result;
}
