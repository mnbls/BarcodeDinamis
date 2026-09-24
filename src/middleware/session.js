import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';

/**
 * Server-side sessions stored in PostgreSQL (table user_sessions): they survive restarts and work
 * across several app processes. The browser only holds an opaque, signed, HttpOnly cookie.
 */
export function createSessionMiddleware(ctx) {
  const { config, db, logger } = ctx;
  const PgStore = connectPgSimple(session);

  const store = new PgStore({
    pool: db.pool,
    tableName: 'user_sessions',
    createTableIfMissing: false,
    // Expired sessions are swept every 15 minutes (disabled under test so no timer keeps the process alive).
    pruneSessionInterval: config.isTest ? false : 15 * 60,
    errorLog: (...args) => logger.error({ args }, 'session store error'),
  });

  // A visitor who is not signed in only has a session to carry the CSRF token of the login form (and a flash
  // message). If the store cannot save it, for instance while the database is down, the page must still be
  // served: express-session reports a failed save AFTER it started writing the response, and Express then
  // destroys the connection mid-flush, so the visitor got a reset instead of the page. Losing an anonymous
  // session costs nothing (the next form just asks for a new token); a signed-in session still fails loudly.
  const persist = store.set.bind(store);
  store.set = (sid, sess, done) => {
    persist(sid, sess, (err) => {
      if (err && !sess.userId) {
        logger.warn({ err }, 'could not persist an anonymous session');
        return done();
      }
      return done(err);
    });
  };

  const middleware = session({
    store,
    name: config.session.cookieName,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // the idle timeout is renewed on every request
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.cookieSecure,
      maxAge: config.session.ttlHours * 60 * 60 * 1000,
      path: '/',
    },
  });

  return { middleware, store };
}
