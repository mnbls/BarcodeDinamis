/* Barcode pages: bulk selection on the list, destination-type switching on the form,
   print sizing, and the CSV import drop zone. */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const number = new Intl.NumberFormat('id-ID');

  /* ---- list: checkbox selection + bulk bar -------------------------------------------------------------- */
  const bulkForm = $('#bulk-form');
  if (bulkForm) {
    const master = $('[data-select-page]');
    const boxes = $$('[data-row-check]');
    const bar = $('[data-bulkbar]');
    const countEl = $('[data-bulk-count]');
    const allBanner = $('[data-bulk-all]');
    const allButton = $('[data-bulk-all-button]');
    const allInput = bulkForm.elements.namedItem('select_all_matching');
    const total = Number(bulkForm.dataset.total || 0);
    const actionButtons = $$('[data-bulk-action]', bar);
    let selectAll = false;

    const selectedCount = () => (selectAll ? total : boxes.filter((b) => b.checked).length);
    // "Select all results" with NO filter means every barcode in the system: the server insists on a typed
    // confirmation for that, so the dialog must ask for it (regardless of how many rows that happens to be).
    const filtersActive = () => ['q', 'status', 'from', 'to', 'batch'].some((name) => bulkForm.elements.namedItem(name)?.value);

    function refresh() {
      const checked = boxes.filter((b) => b.checked).length;
      if (checked === 0) selectAll = false;
      if (allInput) allInput.value = selectAll ? '1' : '';

      bar.classList.toggle('is-visible', checked > 0);
      master.checked = checked > 0 && checked === boxes.length;
      master.indeterminate = checked > 0 && checked < boxes.length;
      boxes.forEach((b) => b.closest('tr')?.classList.toggle('is-selected', b.checked));

      const n = selectedCount();
      countEl.textContent = number.format(n);

      // Offer "select all results" only when the whole page is ticked and more results exist.
      if (allBanner) {
        allBanner.hidden = !(checked === boxes.length && total > boxes.length);
        allButton.textContent = selectAll
          ? 'Batalkan pilihan semua hasil'
          : `Pilih semua ${number.format(total)} barcode yang cocok dengan filter`;
        $('[data-bulk-all-text]').textContent = selectAll
          ? `Semua ${number.format(total)} barcode hasil filter dipilih.`
          : `Semua ${number.format(boxes.length)} barcode di halaman ini dipilih.`;
      }

      // Confirmation copy always states the exact number affected.
      actionButtons.forEach((btn) => {
        const verb = btn.dataset.bulkAction;
        const noun = `${number.format(n)} barcode`;
        if (verb === 'delete') {
          btn.dataset.confirmTitle = `Hapus ${noun}?`;
          btn.dataset.confirmMessage = `${noun} beserta seluruh statistik dan riwayatnya akan dihapus permanen. QR Code yang sudah tercetak akan menampilkan "Barcode Tidak Ditemukan". Tindakan ini tidak dapat dibatalkan.`;
          const wipesEverything = selectAll && !filtersActive();
          if (n > 50 || wipesEverything) btn.dataset.confirmWord = 'HAPUS';
          else delete btn.dataset.confirmWord;
        } else if (verb === 'deactivate') {
          btn.dataset.confirmTitle = `Nonaktifkan ${noun}?`;
          btn.dataset.confirmMessage = 'Pemindai akan melihat halaman "Barcode Tidak Aktif" sampai barcode diaktifkan kembali.';
        } else if (verb === 'activate') {
          btn.dataset.confirmTitle = `Aktifkan ${noun}?`;
          btn.dataset.confirmMessage = 'Barcode akan langsung kembali mengarahkan pemindai ke tujuannya.';
        }
      });
    }

    master.addEventListener('change', () => {
      boxes.forEach((b) => {
        b.checked = master.checked;
      });
      selectAll = false;
      refresh();
    });
    boxes.forEach((b) => b.addEventListener('change', () => {
      selectAll = false;
      refresh();
    }));
    allButton?.addEventListener('click', () => {
      selectAll = !selectAll;
      refresh();
    });
    $('[data-bulk-clear]')?.addEventListener('click', () => {
      boxes.forEach((b) => {
        b.checked = false;
      });
      selectAll = false;
      refresh();
    });
    refresh();
  }

  /* ---- create/edit form: destination type switches labels and the optional extra field ------------------ */
  const typeForm = $('[data-type-form]');
  if (typeForm) {
    let meta = {};
    try {
      meta = JSON.parse(typeForm.dataset.typeMeta || '{}');
    } catch {
      meta = {};
    }
    const value = $('#target_value');
    const label = $('[data-target-label]');
    const hint = $('[data-target-hint]');
    const extraField = $('[data-extra-field]');
    const extraInput = $('#target_extra');
    const extraLabel = $('[data-extra-label]');
    const extraHint = $('[data-extra-hint]');

    function apply(type) {
      const m = meta[type];
      if (!m) return;
      label.textContent = m.label;
      hint.textContent = m.hint;
      value.placeholder = m.placeholder;
      value.inputMode = m.inputmode;
      value.autocomplete = 'off';
      extraField.hidden = !m.extra;
      if (m.extra) {
        extraLabel.textContent = m.extra.label;
        extraInput.placeholder = m.extra.placeholder;
        extraHint.textContent = m.extra.hint;
      } else {
        extraInput.value = '';
      }
    }

    $$('input[name="target_type"]', typeForm).forEach((radio) => {
      radio.addEventListener('change', () => apply(radio.value));
    });
    const checked = $('input[name="target_type"]:checked', typeForm);
    if (checked) apply(checked.value);

    typeForm.addEventListener('submit', () => {
      const submit = $('[type="submit"]', typeForm);
      if (submit) {
        submit.disabled = true;
        submit.setAttribute('aria-busy', 'true');
      }
    });
  }

  /* ---- forms that must not be sent twice: the Maps form asks Google, which can take a few seconds ------------ */
  $$('form[data-single-submit]').forEach((form) => {
    form.addEventListener('submit', () => {
      const submit = $('[type="submit"]', form);
      if (!submit) return;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      if (submit.dataset.busyText) submit.textContent = submit.dataset.busyText;
    });
  });

  /* ---- print: label size ------------------------------------------------------------------------------------- */
  const label = $('[data-label]');
  if (label) {
    $$('input[name="size"]').forEach((radio) => {
      radio.addEventListener('change', () => label.style.setProperty('--qr-size', radio.value));
    });
    if (document.body.dataset.autoprint === '1') setTimeout(() => window.print(), 350);
  }

  /* ---- import: drop zone ------------------------------------------------------------------------------------- */
  const zone = $('[data-dropzone]');
  if (zone) {
    const input = $('input[type="file"]', zone);
    const name = $('[data-dropzone-name]', zone);
    const submit = $('[data-import-submit]');
    const form = zone.closest('form');

    const showFile = () => {
      const file = input.files[0];
      name.textContent = file ? `${file.name} (${number.format(Math.max(1, Math.round(file.size / 1024)))} KB)` : 'Belum ada file dipilih';
      if (submit) submit.disabled = !file;
    };
    input.addEventListener('change', showFile);
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, () => zone.classList.add('is-dragover')));
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('is-dragover')));
    form.addEventListener('submit', () => {
      if (submit) {
        submit.disabled = true;
        submit.setAttribute('aria-busy', 'true');
        submit.textContent = 'Memproses...';
      }
    });
    showFile();
  }

  /* ---- Back button after a submit --------------------------------------------------------------------------------
     The browser may restore the page exactly as it was when the form was sent, with its button still disabled
     ("Memproses..."). That is a dead end for someone who pressed Back to correct something (typically on the
     public edit page), so a page restored from the back/forward cache in that state is simply reloaded. */
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && $('[aria-busy="true"]')) window.location.reload();
  });
})();
