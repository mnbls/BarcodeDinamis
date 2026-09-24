/**
 * One-shot messages that survive a redirect (shown as toast notifications).
 * req.flash('success' | 'error' | 'info', 'text')
 */
export function flash() {
  return (req, res, next) => {
    req.flash = (type, message) => {
      req.session.flash = [...(req.session.flash ?? []), { type, message }];
    };
    const pending = req.session?.flash;
    if (pending?.length) {
      res.locals.flash = pending;
      req.session.flash = [];
    } else {
      res.locals.flash = [];
    }
    next();
  };
}
