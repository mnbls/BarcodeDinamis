/* Global behaviour: mobile navigation, toasts, confirmation dialog, dropdown menus, copy buttons,
   scroll reveal. Plain JavaScript, no dependencies, no inline handlers (the CSP forbids them). */
(() => {
  'use strict';

  document.documentElement.classList.add('js');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ---- mobile navigation ---------------------------------------------------------------------- */
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-nav-toggle]')) document.body.classList.toggle('nav-open');
    else if (event.target.closest('[data-nav-close]')) document.body.classList.remove('nav-open');
  });

  /* ---- toasts ------------------------------------------------------------------------------------ */
  const toastHost = $('#toasts');

  function iconFrom(templateId) {
    const tpl = document.getElementById(templateId);
    return tpl ? tpl.content.cloneNode(true) : document.createDocumentFragment();
  }

  function toast(type, message, timeout = 5500) {
    if (!toastHost || !message) return;
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.appendChild(iconFrom(`tpl-icon-${type}`));

    const text = document.createElement('div');
    text.textContent = message; // never innerHTML: messages can contain user input

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Tutup notifikasi');
    close.appendChild(iconFrom('tpl-icon-close'));

    el.append(icon, text, close);
    toastHost.appendChild(el);

    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 260);
    };
    close.addEventListener('click', dismiss);
    if (timeout) timer = setTimeout(dismiss, timeout);
  }
  window.appToast = toast;

  if (toastHost) {
    try {
      JSON.parse(toastHost.dataset.flash || '[]').forEach((f) => toast(f.type || 'info', f.message));
    } catch {
      /* ignore malformed flash payload */
    }
  }

  /* ---- confirmation dialog -------------------------------------------------------------------------
     Any button with data-confirm opens the dialog first; on "yes" its form is submitted with that
     button as the submitter. Options: data-confirm-title, -message, -label, -variant="danger",
     -word="HAPUS" (the person must type it before the button enables). */
  const dialog = $('#confirm-dialog');
  if (dialog) {
    const title = $('[data-confirm-title]', dialog);
    const message = $('[data-confirm-message]', dialog);
    const okButton = $('[data-confirm-ok]', dialog);
    const iconBox = $('[data-confirm-icon]', dialog);
    const extra = $('[data-confirm-extra]', dialog);
    const extraInput = $('input', extra);
    const extraWord = $('[data-confirm-word]', dialog);
    let pending = null;

    const open = (trigger) => {
      const form = trigger.form || trigger.closest('form');
      if (!form) return;
      pending = { form, trigger };
      const danger = trigger.dataset.confirmVariant === 'danger';
      title.textContent = trigger.dataset.confirmTitle || 'Lanjutkan tindakan ini?';
      message.textContent = trigger.dataset.confirmMessage || '';
      okButton.textContent = trigger.dataset.confirmLabel || 'Ya, lanjutkan';
      okButton.className = `btn ${danger ? 'btn--danger-solid' : 'btn--primary'}`;
      iconBox.classList.toggle('is-danger', danger);

      const word = trigger.dataset.confirmWord;
      extra.hidden = !word;
      extraInput.value = '';
      if (word) extraWord.textContent = word;
      okButton.disabled = Boolean(word);
      pending.word = word || '';

      dialog.showModal();
      (word ? extraInput : okButton).focus();
    };

    extraInput.addEventListener('input', () => {
      okButton.disabled = extraInput.value.trim() !== pending?.word;
    });

    okButton.addEventListener('click', () => {
      if (!pending) return;
      const { form, trigger, word } = pending;
      if (word) {
        const target = form.elements.namedItem('confirm_text');
        if (target) target.value = extraInput.value.trim();
      }
      pending = null;
      dialog.close();
      form.requestSubmit(trigger.type === 'submit' ? trigger : undefined);
    });

    $('[data-confirm-cancel]', dialog).addEventListener('click', () => {
      pending = null;
      dialog.close();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close(); // click on the backdrop
    });

    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-confirm]');
      if (!trigger) return;
      event.preventDefault();
      open(trigger);
    });
  }

  /* ---- dropdown menus (details.menu) ----------------------------------------------------------------
     The panel is position:fixed so tables with overflow scrolling never clip it. */
  const closeMenus = (except) => {
    $$('details.menu[open]').forEach((menu) => {
      if (menu !== except) menu.open = false;
    });
  };

  function placeMenu(menu) {
    const panel = $('.menu__panel', menu);
    const trigger = $('summary', menu);
    if (!panel || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    panel.style.visibility = 'hidden';
    const { offsetWidth: width, offsetHeight: height } = panel;
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 6);
    const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    panel.style.visibility = '';
  }

  document.addEventListener(
    'toggle',
    (event) => {
      const menu = event.target;
      if (menu instanceof HTMLElement && menu.matches('details.menu') && menu.open) {
        closeMenus(menu);
        placeMenu(menu);
      }
    },
    true,
  );
  document.addEventListener('click', (event) => {
    $$('details.menu[open]').forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = $('details.menu[open]');
    if (open) {
      open.open = false;
      $('summary', open)?.focus();
    }
  });
  window.addEventListener('scroll', () => closeMenus(), true);
  window.addEventListener('resize', () => closeMenus());

  /* ---- copy to clipboard ------------------------------------------------------------------------------ */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const ok = await copyText(button.dataset.copy);
    if (ok) {
      button.classList.add('is-done');
      setTimeout(() => button.classList.remove('is-done'), 1600);
      toast('success', button.dataset.copyMessage || 'Berhasil disalin.', 2200);
    } else {
      toast('error', 'Tidak dapat menyalin. Salin secara manual.');
    }
  });

  /* ---- auto-submit filters, password toggle ------------------------------------------------------------ */
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (el instanceof HTMLElement && el.matches('[data-autosubmit]') && el.form) el.form.requestSubmit();
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-toggle-password]');
    if (!button) return;
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    button.setAttribute('aria-pressed', String(show));
  });

  /* ---- print button ------------------------------------------------------------------------------------- */
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-print]')) window.print();
  });

  /* ---- public site: sticky nav border, scroll reveal ------------------------------------------------------ */
  const nav = $('.pub-nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const reveals = $$('.reveal');
  if (reveals.length) {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-in');
              observer.unobserve(entry.target);
            }
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
      );
      reveals.forEach((el) => observer.observe(el));
    } else {
      reveals.forEach((el) => el.classList.add('is-in'));
    }
  }
})();
