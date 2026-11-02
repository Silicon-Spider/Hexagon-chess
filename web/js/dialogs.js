// dialogs.js — modal dialogs: new game, settings, how to play, game over, FEN & export.
import { $, $$, h, escapeHtml, openDialog, closeDialog, closeOnBackdrop, copyText, toast } from './dom.js';
import { rulesHtml, variantInfo } from './rules.js';
import { LEVEL_NAMES, levelDescription, clampLevel } from './ai-client.js';
import { hexPoints, shadeOfClass, SQRT3 } from './geometry.js';

export const BOARD_THEMES = [
  { id: 'walnut', name: 'Walnut' },
  { id: 'slate', name: 'Slate' },
  { id: 'jade', name: 'Jade' },
  { id: 'dusk', name: 'Dusk' },
];

function wireClose(dlg) {
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => closeDialog(dlg, 'cancel')));
  closeOnBackdrop(dlg);
}

/** Seven-cell cluster in a variant's shading (centre + ring). */
export function shadeClusterSvg(variant, cls = 'shade-cluster') {
  const cells = [[0, 0], [0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0]];
  let s = `<svg class="${cls}" viewBox="-2.7 -2.75 5.4 5.5" aria-hidden="true">`;
  for (const [q, r] of cells) {
    const x = 1.5 * q;
    const y = SQRT3 * (r + q / 2);
    const shade = shadeOfClass(variant, (((q - r) % 3) + 3) % 3);
    s += `<polygon class="cell ${shade}" points="${hexPoints(x, y, 0.93, 3)}"/>`;
  }
  return s + '</svg>';
}

function setRadio(form, name, value) {
  const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function radioValue(form, name) {
  const input = form.querySelector(`input[name="${name}"]:checked`);
  return input ? input.value : null;
}

// ------------------------------------------------------------------------- new game

export function setupNewGameDialog({ onStart }) {
  const dlg = $('#dlg-new');
  const form = $('#form-new');
  const level = $('#new-level');
  const levelOut = $('#new-level-out');
  wireClose(dlg);

  const syncLevel = () => {
    const n = clampLevel(level.value);
    levelOut.innerHTML = `<b>${n}</b> ${escapeHtml(LEVEL_NAMES[n])} <span>${escapeHtml(levelDescription(n))}</span>`;
    level.style.setProperty('--fill', `${((n - 1) / 7) * 100}%`);
  };
  const syncMode = () => {
    const mode = radioValue(form, 'mode');
    $$('[data-when]', form).forEach((node) => {
      node.hidden = !node.dataset.when.split(' ').includes(mode);
    });
  };
  level.addEventListener('input', syncLevel);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'mode') syncMode();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cfg = {
      variant: Number(radioValue(form, 'variant') || 0),
      mode: radioValue(form, 'mode') || 'hvc',
      side: radioValue(form, 'side') || 'white',
      level: clampLevel(level.value),
      autoFlip: form.elements.autoflip.checked,
    };
    closeDialog(dlg, 'start');
    onStart(cfg);
  });

  return {
    open(config, variants) {
      const host = $('#new-variants');
      host.innerHTML = '';
      for (const v of variants) {
        const info = variantInfo(v.id, v.name);
        host.appendChild(h('label', { class: 'variant-card' },
          h('input', { type: 'radio', name: 'variant', value: v.id }),
          h('span', { class: 'vc-art', html: shadeClusterSvg(v.id) }),
          h('span', { class: 'vc-text' },
            h('span', { class: 'vc-title' }, v.name, info.year ? h('small', null, info.year) : null),
            h('span', { class: 'vc-blurb' }, info.blurb))));
      }
      setRadio(form, 'variant', config.variant);
      if (!radioValue(form, 'variant') && variants.length) setRadio(form, 'variant', variants[0].id);
      setRadio(form, 'mode', config.mode);
      setRadio(form, 'side', config.side || (config.humanColor === 1 ? 'black' : 'white'));
      level.value = String(config.level);
      form.elements.autoflip.checked = !!config.autoFlip;
      syncLevel();
      syncMode();
      openDialog(dlg);
      const start = form.querySelector('button[type="submit"]');
      if (start) start.focus();
    },
  };
}

// ------------------------------------------------------------------------- settings

export function setupSettingsDialog({ onChange }) {
  const dlg = $('#dlg-settings');
  const form = $('#form-settings');
  wireClose(dlg);
  const grid = $('#theme-grid');
  for (const t of BOARD_THEMES) {
    grid.appendChild(h('label', { class: 'theme-swatch', 'data-board': t.id },
      h('input', { type: 'radio', name: 'theme', value: t.id }),
      h('span', { class: 'ts-art', html: shadeClusterSvg(0, 'shade-cluster') }),
      h('span', { class: 'ts-name' }, t.name)));
  }
  const read = () => ({
    theme: radioValue(form, 'theme') || 'walnut',
    ui: radioValue(form, 'ui') || 'auto',
    coords: form.elements.coords.checked,
    legal: form.elements.legal.checked,
    anim: form.elements.anim.checked,
    sound: form.elements.sound.checked,
    evalBar: form.elements.evalbar.checked,
  });
  form.addEventListener('change', () => onChange(read()));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closeDialog(dlg, 'done');
  });
  return {
    open(s) {
      setRadio(form, 'theme', s.theme);
      setRadio(form, 'ui', s.ui);
      form.elements.coords.checked = !!s.coords;
      form.elements.legal.checked = !!s.legal;
      form.elements.anim.checked = !!s.anim;
      form.elements.sound.checked = !!s.sound;
      form.elements.evalbar.checked = !!s.evalBar;
      openDialog(dlg);
    },
  };
}

// ------------------------------------------------------------------------- how to play

export function setupHelpDialog({ getVariants }) {
  const dlg = $('#dlg-help');
  const tabs = $('#help-tabs');
  const body = $('#help-body');
  wireClose(dlg);
  let current = 0;
  const show = (variant) => {
    const list = getVariants();
    const v = list.find((x) => x.id === variant) || list[0];
    if (!v) return;
    current = v.id;
    $$('button', tabs).forEach((b) => {
      const on = Number(b.dataset.variant) === v.id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    });
    body.innerHTML = rulesHtml({ variant: v.id, name: v.name, startFen: v.startFen, stalemateRule: v.stalemateRule });
    body.scrollTop = 0;
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-variant]');
    if (b) show(Number(b.dataset.variant));
  });
  return {
    open(variant) {
      tabs.innerHTML = '';
      for (const v of getVariants()) {
        tabs.appendChild(h('button', { type: 'button', role: 'tab', class: 'tab', 'data-variant': v.id }, v.name));
      }
      show(variant === undefined ? current : variant);
      openDialog(dlg);
    },
  };
}

// ------------------------------------------------------------------------- game over

export function setupGameOverDialog({ onNew, onReview }) {
  const dlg = $('#dlg-over');
  closeOnBackdrop(dlg);
  $('#over-new').addEventListener('click', () => {
    closeDialog(dlg, 'new');
    onNew();
  });
  $('#over-review').addEventListener('click', () => {
    closeDialog(dlg, 'review');
    onReview();
  });
  return {
    open({ title, score, detail, winner }) {
      $('#over-title').textContent = title;
      $('#over-score').textContent = score;
      $('#over-detail').textContent = detail;
      dlg.dataset.winner = winner === 0 ? 'w' : winner === 1 ? 'b' : 'none';
      openDialog(dlg);
      $('#over-new').focus();
    },
    close() {
      closeDialog(dlg, 'close');
    },
    get isOpen() {
      return dlg.open;
    },
  };
}

// ------------------------------------------------------------------------- FEN & export

export function setupPositionDialog({ onLoad }) {
  const dlg = $('#dlg-position');
  wireClose(dlg);
  const current = $('#fen-current');
  const input = $('#fen-input');
  const select = $('#fen-variant');
  const msg = $('#fen-msg');
  const exportText = $('#export-text');
  const say = (text, kind) => {
    msg.textContent = text;
    msg.dataset.kind = kind || '';
  };
  $('#fen-copy').addEventListener('click', async () => {
    const ok = await copyText(current.value);
    toast(ok ? 'FEN copied to the clipboard' : 'Copy failed — select the text and copy it manually', ok ? 'good' : 'warn');
    if (!ok) current.select();
  });
  $('#export-copy').addEventListener('click', async () => {
    const ok = await copyText(exportText.value);
    toast(ok ? 'Game copied to the clipboard' : 'Copy failed — select the text and copy it manually', ok ? 'good' : 'warn');
    if (!ok) exportText.select();
  });
  $('#fen-load').addEventListener('click', () => {
    const fen = input.value.trim();
    if (!fen) {
      say('Paste a FEN first.', 'error');
      return;
    }
    const err = onLoad(fen, Number(select.value));
    if (err) {
      say(err, 'error');
      return;
    }
    say('');
    closeDialog(dlg, 'loaded');
    toast('Position loaded', 'good');
  });
  input.addEventListener('input', () => say(''));
  return {
    open({ fen, exportText: text, variants, variant }) {
      current.value = fen;
      exportText.value = text;
      select.innerHTML = '';
      for (const v of variants) select.appendChild(h('option', { value: v.id }, `as ${v.name}`));
      select.value = String(variant);
      say('');
      openDialog(dlg);
    },
  };
}
