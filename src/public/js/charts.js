/* Charts: dependency-free SVG line chart + bar tooltips.
   Progressive enhancement: the server renders every chart as a real <table> (the accessible
   "table view"); this script reads that table, draws the chart above it and hides the table.
   Marks follow the data-viz spec: 2px line, 10% area wash, >=8px end dot with a 2px surface ring,
   hairline solid grid, crosshair snapped to the nearest day, one tooltip, keyboard support. */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const number = new Intl.NumberFormat('id-ID');
  const compact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
  const shortDate = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });
  const longDate = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const formatValue = (v) => number.format(v);
  const formatTick = (v) => (v >= 10000 ? compact.format(v) : number.format(v));
  const parseDay = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  function svg(name, attrs = {}) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  /** Tick step from a 1/2/5 x 10^n ladder; counts are integers so the step is never below 1. */
  function niceScale(max) {
    if (max <= 0) return { top: 4, step: 1 };
    const rough = max / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const residual = rough / magnitude;
    let step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
    step = Math.max(1, step);
    return { top: Math.ceil(max / step) * step, step };
  }

  function readTable(figure) {
    return Array.from(figure.querySelectorAll('tbody tr')).map((row) => ({
      day: row.querySelector('[data-date]').dataset.date,
      value: Number(row.querySelector('[data-value]').dataset.value),
    }));
  }

  function drawLineChart(figure) {
    const canvas = figure.querySelector('.chart__canvas');
    const label = figure.dataset.label || 'Scan';
    const points = readTable(figure);
    if (!canvas || points.length === 0) return;

    const table = figure.querySelector('.chart__table');
    const toggle = figure.querySelector('[data-chart-toggle]');
    if (table) table.hidden = true;

    let active = points.length - 1;
    let tip;
    let cross;
    let activeDot;
    let geometry;

    function layout() {
      const width = Math.max(280, Math.floor(canvas.clientWidth));
      const height = width < 520 ? 210 : 250;
      const margin = { top: 16, right: 22, bottom: 30, left: 44 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;
      const max = Math.max(...points.map((p) => p.value));
      const scale = niceScale(max);
      const x = (i) => margin.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
      const y = (v) => margin.top + innerH - (v / scale.top) * innerH;
      return { width, height, margin, innerW, innerH, max, scale, x, y };
    }

    function render() {
      geometry = layout();
      const { width, height, margin, innerW, innerH, max, scale, x, y } = geometry;
      canvas.replaceChildren();

      const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
      root.setAttribute('aria-label', `Grafik ${label.toLowerCase()} per hari, ${points.length} hari. Tabel data tersedia.`);

      // grid + y ticks
      const grid = svg('g', { class: 'chart__grid' });
      const base = svg('g', { class: 'chart__base' });
      for (let v = 0; v <= scale.top; v += scale.step) {
        const line = svg('line', { x1: margin.left, x2: width - margin.right, y1: y(v), y2: y(v) });
        (v === 0 ? base : grid).appendChild(line);
        const text = svg('text', { class: 'chart__tick', x: margin.left - 10, y: y(v) + 4, 'text-anchor': 'end' });
        text.textContent = formatTick(v);
        root.appendChild(text);
      }
      root.prepend(grid, base);

      // x labels: as many as fit, always ending on the last day
      const fit = Math.max(2, Math.floor(innerW / 68));
      const stride = Math.max(1, Math.ceil(points.length / fit));
      for (let i = points.length - 1; i >= 0; i -= stride) {
        const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
        const text = svg('text', { class: 'chart__tick', x: x(i), y: height - 8, 'text-anchor': anchor });
        text.textContent = shortDate.format(parseDay(points[i].day));
        root.appendChild(text);
      }

      // area + line
      const coords = points.map((p, i) => [x(i), y(p.value)]);
      if (points.length > 1) {
        const line = coords.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        root.appendChild(svg('path', { class: 'chart__area', d: `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` }));
        root.appendChild(svg('path', { class: 'chart__line', d: line }));
      }

      // end dot + end label (selective direct label: the latest value)
      const last = points.length - 1;
      root.appendChild(svg('circle', { class: 'chart__dot', cx: x(last), cy: y(points[last].value), r: 4.5 }));
      if (points[last].value > 0) {
        const endLabel = svg('text', {
          class: 'chart__end-label',
          x: x(last) - (points.length > 1 ? 8 : 0),
          y: y(points[last].value) - 12,
          'text-anchor': points.length > 1 ? 'end' : 'middle',
        });
        endLabel.textContent = formatValue(points[last].value);
        root.appendChild(endLabel);
      }

      // hover layer
      cross = svg('line', { class: 'chart__cross', y1: margin.top, y2: margin.top + innerH, x1: 0, x2: 0, visibility: 'hidden' });
      activeDot = svg('circle', { class: 'chart__dot', r: 5, cx: 0, cy: 0, visibility: 'hidden' });
      root.append(cross, activeDot);

      const hit = svg('rect', {
        class: 'chart__hit',
        x: margin.left,
        y: margin.top,
        width: innerW,
        height: innerH + 4,
        tabindex: 0,
        role: 'group',
        'aria-label': `Jelajahi nilai per hari dengan tombol panah kiri dan kanan`,
      });
      root.appendChild(hit);
      canvas.appendChild(root);

      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.setAttribute('aria-hidden', 'true');
      canvas.appendChild(tip);

      if (max === 0) {
        const empty = document.createElement('div');
        empty.className = 'chart__empty';
        empty.textContent = `Belum ada ${label.toLowerCase()} pada periode ini.`;
        canvas.appendChild(empty);
      }

      const indexAt = (clientX) => {
        const rect = root.getBoundingClientRect();
        const rel = ((clientX - rect.left) / rect.width) * width;
        const ratio = (rel - margin.left) / innerW;
        return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
      };
      hit.addEventListener('pointermove', (e) => show(indexAt(e.clientX)));
      hit.addEventListener('pointerdown', (e) => show(indexAt(e.clientX)));
      hit.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse') hideTip();
      });
      hit.addEventListener('focus', () => show(active));
      hit.addEventListener('blur', hideTip);
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') show(Math.max(0, active - 1));
        else if (e.key === 'ArrowRight') show(Math.min(points.length - 1, active + 1));
        else if (e.key === 'Home') show(0);
        else if (e.key === 'End') show(points.length - 1);
        else if (e.key === 'Escape') hideTip();
        else return;
        e.preventDefault();
      });
    }

    function show(i) {
      active = i;
      const { margin, innerH, x, y, width } = geometry;
      const p = points[i];
      const px = x(i);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      activeDot.setAttribute('cx', px);
      activeDot.setAttribute('cy', y(p.value));
      activeDot.setAttribute('visibility', 'visible');

      tip.replaceChildren();
      const date = document.createElement('div');
      date.className = 'chart-tip__date';
      date.textContent = longDate.format(parseDay(p.day));
      const row = document.createElement('div');
      row.className = 'chart-tip__row';
      const key = document.createElement('span');
      key.className = 'chart-tip__key';
      const value = document.createElement('span');
      value.className = 'chart-tip__value';
      value.textContent = formatValue(p.value);
      const unit = document.createElement('span');
      unit.className = 'chart-tip__label';
      unit.textContent = label.toLowerCase();
      row.append(key, value, unit);
      tip.append(date, row);

      const tipWidth = tip.offsetWidth;
      const left = px + 14 + tipWidth > width - 4 ? px - 14 - tipWidth : px + 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${margin.top + Math.min(innerH - 40, Math.max(0, y(p.value) - margin.top - 24))}px`;
      tip.classList.add('is-visible');
    }

    function hideTip() {
      if (!tip) return;
      tip.classList.remove('is-visible');
      cross.setAttribute('visibility', 'hidden');
      activeDot.setAttribute('visibility', 'hidden');
    }

    if (toggle) {
      toggle.addEventListener('click', () => {
        const showTable = table.hidden;
        table.hidden = !showTable;
        canvas.hidden = showTable;
        toggle.setAttribute('aria-pressed', String(showTable));
        toggle.textContent = showTable ? 'Lihat grafik' : 'Lihat tabel';
      });
    }

    render();
    let frame;
    let lastWidth = canvas.clientWidth;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = canvas.clientWidth;
        if (canvas.hidden || width === 0 || width === lastWidth) return;
        lastWidth = width;
        render();
      });
    }).observe(canvas);
  }

  document.querySelectorAll('figure[data-chart="line"]').forEach(drawLineChart);

  /* ---- bar rows: hover / focus tooltip with label, value and share ---------------------------------- */
  const rows = document.querySelectorAll('.bar-row[data-tip]');
  if (rows.length) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.style.position = 'fixed';
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);

    const show = (row, x, y) => {
      const [label, value, share] = row.dataset.tip.split('|');
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'chart-tip__date';
      head.textContent = label;
      const line = document.createElement('div');
      line.className = 'chart-tip__row';
      const strong = document.createElement('span');
      strong.className = 'chart-tip__value';
      strong.textContent = value;
      const rest = document.createElement('span');
      rest.className = 'chart-tip__label';
      rest.textContent = `scan · ${share}`;
      line.append(strong, rest);
      tip.append(head, line);
      const left = Math.min(x + 14, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, y - tip.offsetHeight - 12)}px`;
      tip.classList.add('is-visible');
    };
    const hide = () => tip.classList.remove('is-visible');

    rows.forEach((row) => {
      row.addEventListener('pointermove', (e) => show(row, e.clientX, e.clientY));
      row.addEventListener('pointerleave', hide);
      row.addEventListener('focus', () => {
        const r = row.getBoundingClientRect();
        show(row, r.left + r.width / 2, r.top);
      });
      row.addEventListener('blur', hide);
    });
  }
})();
