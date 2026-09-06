import { getGoogleStore } from "@emulators/google";

const DECLARED = "worldfixture.google.calendars.declared";
const missing = c => c.json({ error: { code: 404, message: "Requested entity was not found.",
  errors: [{ message: "Requested entity was not found.", domain: "global", reason: "notFound" }], status: "NOT_FOUND" } }, 404);

// The native calendar helpers create a primary calendar during reads when an
// owner has none. An explicit calendar inventory must not trigger that fallback.
// Keep the declaration in normal provider state so restart/reset use the same
// contract. Existing calendars and events remain in the native provider store.
export function wrapDeclaredGoogleCalendars(upstream, upstreamSeed) {
  return {
    plugin: { ...upstream, register(app, store, ...args) {
      const empty = c => store.getData(DECLARED) === true && c.get("authUser")?.login
        && getGoogleStore(store).calendars.findBy("user_email", c.get("authUser").login).length === 0;
      app.use("/calendar/v3/users/:userId/calendarList", (c, next) => {
        if (c.req.method !== "GET") return next();
        if (!empty(c)) return next(); // Native authentication handles missing identities.
        if (!["me", c.get("authUser").login].includes(c.req.param("userId"))) return missing(c);
        return c.json({ kind: "calendar#calendarList", items: [] });
      });
      app.use("*", (c, next) => c.req.path.startsWith("/calendar/v3/calendars/") && empty(c) ? missing(c) : next());
      app.use("/calendar/v3/freeBusy", async (c, next) => {
        if (c.req.method !== "POST") return next();
        if (!empty(c)) return next();
        let input;
        try { input = await c.req.json(); } catch { input = {}; }
        const body = input?.requestBody ?? input;
        if (typeof body?.timeMin !== "string" || typeof body?.timeMax !== "string") {
          return c.json({ error: { code: 400, message: "timeMin and timeMax are required.", status: "INVALID_ARGUMENT" } }, 400);
        }
        return c.json({ kind: "calendar#freeBusy", timeMin: body.timeMin, timeMax: body.timeMax,
          calendars: Object.fromEntries((Array.isArray(body.items) ? body.items : [])
            .filter(item => typeof item?.id === "string" && item.id)
            .map(item => [item.id, { errors: [{ domain: "global", reason: "notFound" }] }])) });
      });
      upstream.register(app, store, ...args);
    } },
    seedFromConfig(store, baseUrl, config = {}, ...args) {
      if (Object.hasOwn(config, "calendars") && !Array.isArray(config.calendars)) throw new Error("Google calendars must be an explicit array");
      upstreamSeed(store, baseUrl, config, ...args);
      store.setData(DECLARED, Object.hasOwn(config, "calendars"));
    },
  };
}
