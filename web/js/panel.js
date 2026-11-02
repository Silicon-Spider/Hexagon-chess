// panel.js — the side panel: status line, thinking indicator, evaluation bar, players
// with captured pieces, SAN move list with navigation, and the action buttons.
import { $, h } from './dom.js';
import { pieceSvg } from './pieces.js';

const CAPTURE_ORDER = [5, 4, 3, 2, 1];

/**
 * SAN as DOM nodes. The file letter l is set in the italic serif of the board coordinates:
 * in the UI font it is a bare vertical stroke that reads as a capital I ("Rl5" vs "RI5").
 */
function sanNodes(san) {
  const out = [];
  String(san).split('l').forEach((part, i) => {
    if (i) out.push(h('span', { class: 'file-l' }, 'l'));
    if (part) out.push(part);
  });
  return out;
}

export class Panel {
  /**
   * handlers: onJump(ply), onNav('first'|'prev'|'next'|'last'), onFlip(), onUndo(),
   * onRedo(), onPause(), onPosition(), onResume()
   */
  constructor(handlers) {
    this.h = handlers;
    this.r = {
      statusCard: $('#status-card'),
      turnChip: $('#turn-chip'),
      statusMain: $('#status-main'),
      statusSub: $('#status-sub'),
      thinking: $('#thinking'),
      eval: $('#eval'),
      evalWhite: $('#eval-white'),
      evalScore: $('#eval-score'),
      searchInfo: $('#search-info'),
      review: $('#review-bar'),
      reviewText: $('#review-text'),
      resume: $('#btn-resume'),
      live: $('#btn-live'),
      playerTop: $('#player-top'),
      playerBottom: $('#player-bottom'),
      moveList: $('#move-list'),
      movesMeta: $('#moves-meta'),
      first: $('#nav-first'),
      prev: $('#nav-prev'),
      next: $('#nav-next'),
      last: $('#nav-last'),
      flip: $('#btn-flip'),
      undo: $('#btn-undo'),
      redo: $('#btn-redo'),
      pause: $('#btn-pause'),
      position: $('#btn-position'),
    };
    const r = this.r;
    r.first.addEventListener('click', () => this.h.onNav('first'));
    r.prev.addEventListener('click', () => this.h.onNav('prev'));
    r.next.addEventListener('click', () => this.h.onNav('next'));
    r.last.addEventListener('click', () => this.h.onNav('last'));
    r.live.addEventListener('click', () => this.h.onNav('last'));
    r.flip.addEventListener('click', () => this.h.onFlip());
    r.undo.addEventListener('click', () => this.h.onUndo());
    r.redo.addEventListener('click', () => this.h.onRedo());
    r.pause.addEventListener('click', () => this.h.onPause());
    r.position.addEventListener('click', () => this.h.onPosition());
    r.resume.addEventListener('click', () => this.h.onResume());
    r.moveList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ply]');
      if (btn) this.h.onJump(Number(btn.dataset.ply));
    });
    this.lastMovesKey = '';
    this.currentMove = null;
    this.currentPly = 0;
    // Keep the current move in view when the list changes size (window resize, rotation,
    // switching between the one- and two-column layouts), not only when a move is made.
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this._revealCurrent());
      this.resizeObserver.observe(r.moveList);
    }
  }

  render(v) {
    const r = this.r;
    r.statusCard.dataset.tone = v.tone || 'normal';
    r.turnChip.dataset.side = v.turn === 0 ? 'w' : 'b';
    r.turnChip.classList.toggle('pulse', !!v.thinking);
    r.statusMain.textContent = v.statusMain;
    r.statusSub.textContent = v.statusSub || '';
    r.thinking.hidden = !v.thinking;

    if (v.eval) {
      r.eval.hidden = false;
      const frac = v.eval.whiteShare;
      r.evalWhite.style.width = `${(frac * 100).toFixed(1)}%`;
      r.evalScore.textContent = v.eval.text;
      r.evalScore.dataset.lead = v.eval.lead;
    } else {
      r.eval.hidden = true;
    }
    r.searchInfo.textContent = v.searchLine || '';
    r.searchInfo.hidden = !v.searchLine;

    if (v.review) {
      r.review.hidden = false;
      if (v.review.lead !== undefined) r.reviewText.replaceChildren(v.review.lead, ...sanNodes(v.review.san || ''), v.review.tail || '');
      else r.reviewText.textContent = v.review.text;
      r.resume.hidden = !v.review.canResume;
    } else {
      r.review.hidden = true;
    }

    this._renderPlayer(r.playerTop, v.players[0]);
    this._renderPlayer(r.playerBottom, v.players[1]);
    this._renderMoves(v.moves);

    r.first.disabled = !v.canBack;
    r.prev.disabled = !v.canBack;
    r.next.disabled = !v.canForward;
    r.last.disabled = !v.canForward;
    r.undo.disabled = !v.canUndo;
    r.redo.disabled = !v.canRedo;
    r.pause.hidden = v.mode !== 'cvc';
    r.pause.classList.toggle('is-paused', !!v.paused);
    const pauseLabel = r.pause.querySelector('.btn-label');
    if (pauseLabel) pauseLabel.textContent = v.paused ? 'Resume' : 'Pause';
    r.pause.title = v.paused ? 'Resume the demo' : 'Pause the demo';
  }

  _renderPlayer(node, p) {
    node.dataset.side = p.side === 0 ? 'w' : 'b';
    node.classList.toggle('to-move', !!p.toMove);
    node.querySelector('.player-name').textContent = p.name;
    node.querySelector('.player-sub').textContent = p.sub || '';
    const caps = node.querySelector('.player-captures');
    const key = p.captured.join(',');
    if (caps.dataset.key !== key) {
      caps.dataset.key = key;
      caps.innerHTML = '';
      const counts = new Map();
      for (const t of p.captured) counts.set(t, (counts.get(t) || 0) + 1);
      const victimColor = p.side === 0 ? 1 : 0;
      for (const t of CAPTURE_ORDER) {
        const n = counts.get(t) || 0;
        if (!n) continue;
        const group = h('span', { class: 'cap-group' });
        for (let i = 0; i < n; i++) group.insertAdjacentHTML('beforeend', pieceSvg(victimColor, t, 20));
        caps.appendChild(group);
      }
    }
    node.querySelector('.player-adv').textContent = p.adv || '';
  }

  _renderMoves(m) {
    const list = this.r.moveList;
    const key = `${m.firstNumber}|${m.firstColor}|${m.ply}|${m.sans.join(' ')}`;
    if (key === this.lastMovesKey) return;
    this.lastMovesKey = key;
    list.innerHTML = '';
    this.currentMove = null;
    this.currentPly = m.ply;
    if (!m.sans.length) {
      list.appendChild(h('p', { class: 'moves-empty' }, m.emptyText || 'No moves yet.'));
      this.r.movesMeta.textContent = '';
      list.scrollTop = 0;
      return;
    }
    let row = null;
    let current = null;
    m.sans.forEach((san, i) => {
      const color = (m.firstColor + i) % 2;
      const number = m.firstNumber + Math.floor((i + m.firstColor) / 2);
      if (!row || color === 0) {
        row = h('div', { class: 'move-row', role: 'listitem' }, h('span', { class: 'move-no' }, `${number}.`));
        list.appendChild(row);
        if (color === 1) row.appendChild(h('span', { class: 'move-cell move-skip' }, '…'));
      }
      const ply = i + 1;
      const state = ply < m.ply ? 'past' : ply === m.ply ? 'current' : 'future';
      const btn = h('button', {
        type: 'button',
        class: `move-cell move ${state}`,
        'data-ply': ply,
        title: `Go to ${number}${color === 0 ? '.' : '…'} ${san}`,
        'aria-current': state === 'current' ? 'step' : null,
      }, h('span', { class: 'san' }, sanNodes(san)));
      row.appendChild(btn);
      if (state === 'current') current = btn;
    });
    const total = m.sans.length;
    this.r.movesMeta.textContent = m.ply < total ? `${m.ply} / ${total} plies` : `${total} ${total === 1 ? 'ply' : 'plies'}`;
    this.currentMove = current;
    this._revealCurrent();
  }

  /**
   * Scroll the move list (never the page) so the current move is visible. The list is the
   * offsetParent of its rows: it is position: relative in style.css.
   */
  _revealCurrent() {
    const list = this.r.moveList;
    const target = this.currentMove || (this.currentPly === 0 ? null : list.lastElementChild);
    if (!target || !target.isConnected) {
      list.scrollTop = 0;
      return;
    }
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    if (top < list.scrollTop + 4) list.scrollTop = Math.max(0, top - 28);
    else if (bottom > list.scrollTop + list.clientHeight - 4) list.scrollTop = bottom - list.clientHeight + 28;
  }
}
