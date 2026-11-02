//! Move generation, attack detection and legality (SPEC §1.1, §2.1).
//!
//! Legal generation is direct (no make/test/unmake): checkers and pinned pieces are found
//! once per call; non-king moves are restricted to the check-evasion mask and, for pinned
//! pieces, to the pin line; king destinations are tested with the king removed from the
//! occupancy (so sliders x-ray through it). En-passant captures — which remove two pieces
//! from their lines — are verified by recomputing the attacks on the king.

use core::fmt;
use core::mem::MaybeUninit;
use core::ops::{Deref, DerefMut};

use crate::geometry::*;
use crate::position::*;
use crate::variant::*;

/// Capacity of a [`MoveList`]. Far above any reachable position's move count
/// (a lone queen has at most 42 moves; the start positions have 51 / 31).
pub const MAX_MOVES: usize = 512;

/// Fixed-capacity, allocation-free move list (lives on the stack). Derefs to `[Move]`.
pub struct MoveList {
    len: usize,
    buf: [MaybeUninit<Move>; MAX_MOVES],
}

impl MoveList {
    #[inline(always)]
    pub fn new() -> MoveList {
        MoveList { len: 0, buf: [const { MaybeUninit::uninit() }; MAX_MOVES] }
    }
    /// Appends a move (silently ignored if the list is full — cannot happen in practice).
    #[inline(always)]
    pub fn push(&mut self, mv: Move) {
        if self.len < MAX_MOVES {
            self.buf[self.len] = MaybeUninit::new(mv);
            self.len += 1;
        } else {
            debug_assert!(false, "MoveList overflow");
        }
    }
    #[inline(always)]
    pub fn clear(&mut self) {
        self.len = 0;
    }
    #[inline(always)]
    pub fn truncate(&mut self, len: usize) {
        if len < self.len {
            self.len = len;
        }
    }
    #[inline(always)]
    pub fn as_slice(&self) -> &[Move] {
        // SAFETY: the first `len` entries are initialised.
        unsafe { core::slice::from_raw_parts(self.buf.as_ptr() as *const Move, self.len) }
    }
    #[inline(always)]
    pub fn as_mut_slice(&mut self) -> &mut [Move] {
        // SAFETY: the first `len` entries are initialised.
        unsafe { core::slice::from_raw_parts_mut(self.buf.as_mut_ptr() as *mut Move, self.len) }
    }
    /// Raw pointer to the moves (as `u32` codes), for the ABI.
    #[inline(always)]
    pub fn as_ptr(&self) -> *const u32 {
        self.buf.as_ptr() as *const u32
    }
    /// The move whose from/to/promotion equal `key & 0xFFFFF`, if any.
    #[inline]
    pub fn find_key(&self, key: u32) -> Option<Move> {
        let key = key & Move::KEY_MASK;
        self.iter().copied().find(|m| m.key() == key)
    }
}

impl Default for MoveList {
    fn default() -> Self {
        MoveList::new()
    }
}

impl Clone for MoveList {
    fn clone(&self) -> Self {
        let mut l = MoveList::new();
        for &m in self.iter() {
            l.push(m);
        }
        l
    }
}

impl Deref for MoveList {
    type Target = [Move];
    #[inline(always)]
    fn deref(&self) -> &[Move] {
        self.as_slice()
    }
}

impl DerefMut for MoveList {
    #[inline(always)]
    fn deref_mut(&mut self) -> &mut [Move] {
        self.as_mut_slice()
    }
}

impl<'a> IntoIterator for &'a MoveList {
    type Item = &'a Move;
    type IntoIter = core::slice::Iter<'a, Move>;
    fn into_iter(self) -> Self::IntoIter {
        self.as_slice().iter()
    }
}

impl fmt::Debug for MoveList {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.iter()).finish()
    }
}

#[inline(always)]
fn nearest(dir: usize, bb: Bitboard) -> usize {
    if DIR_POSITIVE[dir] {
        lsb(bb)
    } else {
        msb(bb)
    }
}

/// If the first piece on the ray from the king is `own` and the next one is one of
/// `sliders`, returns the first piece's bit (it is pinned), else 0.
#[inline(always)]
fn pin_on_ray(dir: usize, ksq: usize, occ: Bitboard, own: Bitboard, sliders: Bitboard) -> Bitboard {
    let ray = RAYS[dir][ksq];
    if ray & sliders == 0 {
        return 0;
    }
    let blockers = ray & occ;
    let b1 = nearest(dir, blockers);
    let b1bit = bit(b1);
    if own & b1bit == 0 {
        return 0;
    }
    let beyond = blockers & RAYS[dir][b1];
    if beyond == 0 {
        return 0;
    }
    if sliders & bit(nearest(dir, beyond)) != 0 {
        b1bit
    } else {
        0
    }
}

/// Cells a piece pinned on `from` may move to: the ray from the king through it.
#[inline(always)]
fn pin_line(ksq: usize, from: usize) -> Bitboard {
    RAYS[DIR_BETWEEN[ksq][from] as usize][ksq]
}

#[inline(always)]
fn push_promotions(list: &mut MoveList, from: usize, to: usize, flags: u32, victim: usize) {
    let flags = flags | Move::PROMOTION;
    list.push(Move::new(from, to, QUEEN, flags, PAWN, victim));
    list.push(Move::new(from, to, ROOK, flags, PAWN, victim));
    list.push(Move::new(from, to, BISHOP, flags, PAWN, victim));
    list.push(Move::new(from, to, KNIGHT, flags, PAWN, victim));
}

impl Position {
    // -- attacks ------------------------------------------------------------------------

    /// All pieces of colour `by` attacking `sq`, sliders evaluated with occupancy `occ`.
    #[inline]
    pub fn attackers_to(&self, sq: usize, by: usize, occ: Bitboard) -> Bitboard {
        let k = &self.by_kind;
        let them = self.by_color[by];
        let mut a = (KNIGHT_ATTACKS[sq] & k[KNIGHT])
            | (KING_ATTACKS[sq] & k[KING])
            | (PAWN_ATTACKS[self.variant as usize][by ^ 1][sq] & k[PAWN]);
        let orth = (k[ROOK] | k[QUEEN]) & them;
        if ORTHO_LINES[sq] & orth != 0 {
            a |= rook_attacks(sq, occ) & orth;
        }
        let diag = (k[BISHOP] | k[QUEEN]) & them;
        if DIAG_LINES[sq] & diag != 0 {
            a |= bishop_attacks(sq, occ) & diag;
        }
        a & them
    }

    /// True if colour `by` attacks `sq` with sliders evaluated on occupancy `occ`.
    #[inline]
    pub fn is_attacked_occ(&self, sq: usize, by: usize, occ: Bitboard) -> bool {
        let k = &self.by_kind;
        let them = self.by_color[by];
        if ((KNIGHT_ATTACKS[sq] & k[KNIGHT])
            | (KING_ATTACKS[sq] & k[KING])
            | (PAWN_ATTACKS[self.variant as usize][by ^ 1][sq] & k[PAWN]))
            & them
            != 0
        {
            return true;
        }
        let orth = (k[ROOK] | k[QUEEN]) & them;
        if ORTHO_LINES[sq] & orth != 0 {
            for d in 0..6 {
                if RAYS[d][sq] & orth != 0 && ray_attacks(d, sq, occ) & orth != 0 {
                    return true;
                }
            }
        }
        let diag = (k[BISHOP] | k[QUEEN]) & them;
        if DIAG_LINES[sq] & diag != 0 {
            for d in 6..12 {
                if RAYS[d][sq] & diag != 0 && ray_attacks(d, sq, occ) & diag != 0 {
                    return true;
                }
            }
        }
        false
    }

    /// True if colour `by` attacks `sq` in the current position.
    #[inline]
    pub fn is_attacked(&self, sq: usize, by: usize) -> bool {
        self.is_attacked_occ(sq, by, self.occupied())
    }

    /// True if the side to move is in check.
    #[inline]
    pub fn in_check(&self) -> bool {
        let k = self.king[self.side];
        k != NO_CELL && self.is_attacked(k as usize, self.side ^ 1)
    }

    /// Pieces giving check to the side to move.
    #[inline]
    pub fn checkers(&self) -> Bitboard {
        let k = self.king[self.side];
        if k == NO_CELL {
            0
        } else {
            self.attackers_to(k as usize, self.side ^ 1, self.occupied())
        }
    }

    /// Pieces of colour `us` pinned to their own king (`ksq`).
    pub fn pinned_pieces(&self, ksq: usize, us: usize, occ: Bitboard) -> Bitboard {
        let k = &self.by_kind;
        let them = self.by_color[us ^ 1];
        let own = self.by_color[us];
        let orth = (k[ROOK] | k[QUEEN]) & them;
        let diag = (k[BISHOP] | k[QUEEN]) & them;
        let mut pinned = 0;
        if ORTHO_LINES[ksq] & orth != 0 {
            for d in 0..6 {
                pinned |= pin_on_ray(d, ksq, occ, own, orth);
            }
        }
        if DIAG_LINES[ksq] & diag != 0 {
            for d in 6..12 {
                pinned |= pin_on_ray(d, ksq, occ, own, diag);
            }
        }
        pinned
    }

    // -- generation ---------------------------------------------------------------------

    /// All legal moves (the list is cleared first).
    #[inline]
    pub fn gen_legal(&self, list: &mut MoveList) {
        list.clear();
        self.generate::<true, false>(list);
    }

    /// Legal captures, promotions (incl. quiet promotions, all four pieces) and en passant.
    #[inline]
    pub fn gen_legal_noisy(&self, list: &mut MoveList) {
        list.clear();
        self.generate::<true, true>(list);
    }

    /// Pseudo-legal moves (may leave the own king attacked; check with [`Position::is_legal`]).
    #[inline]
    pub fn gen_pseudo(&self, list: &mut MoveList) {
        list.clear();
        self.generate::<false, false>(list);
    }

    /// Pseudo-legal captures, promotions and en passant.
    #[inline]
    pub fn gen_pseudo_noisy(&self, list: &mut MoveList) {
        list.clear();
        self.generate::<false, true>(list);
    }

    /// Convenience: a new list with all legal moves.
    pub fn legal_moves(&self) -> MoveList {
        let mut l = MoveList::new();
        self.gen_legal(&mut l);
        l
    }

    /// True if the side to move has at least one legal move.
    pub fn has_legal_move(&self) -> bool {
        let mut l = MoveList::new();
        self.gen_legal(&mut l);
        !l.is_empty()
    }

    /// True if the pseudo-legal move `mv` does not leave the mover's king attacked.
    #[inline]
    pub fn is_legal(&mut self, mv: Move) -> bool {
        let us = self.side;
        if self.king[us] == NO_CELL {
            return true;
        }
        let undo = self.make(mv);
        let ok = !self.is_attacked(self.king[us] as usize, us ^ 1);
        self.unmake(mv, &undo);
        ok
    }

    /// True if `mv` (legal in this position) gives check.
    pub fn gives_check(&mut self, mv: Move) -> bool {
        let undo = self.make(mv);
        let c = self.in_check();
        self.unmake(mv, &undo);
        c
    }

    #[inline(always)]
    fn push_moves(&self, list: &mut MoveList, from: usize, kind: usize, caps: Bitboard, quiets: Bitboard) {
        let mut c = caps;
        while c != 0 {
            let to = pop_lsb(&mut c);
            list.push(Move::new(from, to, 0, Move::CAPTURE, kind, self.kind_at(to)));
        }
        let mut q = quiets;
        while q != 0 {
            let to = pop_lsb(&mut q);
            list.push(Move::new(from, to, 0, 0, kind, 0));
        }
    }

    fn generate<const LEGAL: bool, const NOISY: bool>(&self, list: &mut MoveList) {
        let us = self.side;
        let them = us ^ 1;
        let own = self.by_color[us];
        let enemy = self.by_color[them];
        let occ = own | enemy;
        let empty = ALL_CELLS & !occ;
        let k = &self.by_kind;
        let v = self.variant as usize;

        let has_king = self.king[us] != NO_CELL;
        let ksq = if has_king { self.king[us] as usize } else { 0 };
        let mut evasion = ALL_CELLS;
        let mut pinned: Bitboard = 0;

        if has_king {
            let targets = KING_ATTACKS[ksq] & !own;
            let occ_nk = occ ^ bit(ksq);
            let mut caps = targets & enemy;
            while caps != 0 {
                let to = pop_lsb(&mut caps);
                if !LEGAL || !self.is_attacked_occ(to, them, occ_nk) {
                    list.push(Move::new(ksq, to, 0, Move::CAPTURE, KING, self.kind_at(to)));
                }
            }
            if !NOISY {
                let mut quiets = targets & empty;
                while quiets != 0 {
                    let to = pop_lsb(&mut quiets);
                    if !LEGAL || !self.is_attacked_occ(to, them, occ_nk) {
                        list.push(Move::new(ksq, to, 0, 0, KING, 0));
                    }
                }
            }
            if LEGAL {
                let checkers = self.attackers_to(ksq, them, occ);
                if checkers != 0 {
                    if checkers & (checkers - 1) != 0 {
                        // Double check: only the king may move. (An en-passant capture can
                        // never parry a double check; it is tested generically anyway.)
                        self.gen_en_passant::<LEGAL>(list);
                        return;
                    }
                    evasion = between(ksq, lsb(checkers)) | checkers;
                }
                pinned = self.pinned_pieces(ksq, us, occ);
            }
        }

        let cap_mask = enemy & evasion;
        let quiet_mask = if NOISY { 0 } else { empty & evasion };

        // Knights (a pinned knight can never stay on its pin line).
        let mut bb = own & k[KNIGHT] & !pinned;
        while bb != 0 {
            let from = pop_lsb(&mut bb);
            let att = KNIGHT_ATTACKS[from];
            self.push_moves(list, from, KNIGHT, att & cap_mask, att & quiet_mask);
        }
        // Sliders.
        let mut bb = own & k[BISHOP];
        while bb != 0 {
            let from = pop_lsb(&mut bb);
            let mut att = bishop_attacks(from, occ);
            if pinned & bit(from) != 0 {
                att &= pin_line(ksq, from);
            }
            self.push_moves(list, from, BISHOP, att & cap_mask, att & quiet_mask);
        }
        let mut bb = own & k[ROOK];
        while bb != 0 {
            let from = pop_lsb(&mut bb);
            let mut att = rook_attacks(from, occ);
            if pinned & bit(from) != 0 {
                att &= pin_line(ksq, from);
            }
            self.push_moves(list, from, ROOK, att & cap_mask, att & quiet_mask);
        }
        let mut bb = own & k[QUEEN];
        while bb != 0 {
            let from = pop_lsb(&mut bb);
            let mut att = queen_attacks(from, occ);
            if pinned & bit(from) != 0 {
                att &= pin_line(ksq, from);
            }
            self.push_moves(list, from, QUEEN, att & cap_mask, att & quiet_mask);
        }

        // Pawns.
        let pawns = own & k[PAWN];
        if pawns != 0 {
            let push = &PAWN_PUSH[us];
            let patt = &PAWN_ATTACKS[v][us];
            let promo_cells = PROMOTION_CELLS[us];
            let dbl = VARIANTS[v].double_step[us];
            let mut bb = pawns;
            while bb != 0 {
                let from = pop_lsb(&mut bb);
                let mask = if pinned & bit(from) != 0 { evasion & pin_line(ksq, from) } else { evasion };
                let f = push[from];
                if f != NO_CELL && empty & bit(f as usize) != 0 {
                    let f = f as usize;
                    let fb = bit(f);
                    if promo_cells & fb != 0 {
                        if mask & fb != 0 {
                            push_promotions(list, from, f, 0, 0);
                        }
                    } else if !NOISY {
                        if mask & fb != 0 {
                            list.push(Move::new(from, f, 0, 0, PAWN, 0));
                        }
                        if dbl & bit(from) != 0 {
                            let f2 = push[f];
                            if f2 != NO_CELL && empty & mask & bit(f2 as usize) != 0 {
                                list.push(Move::new(from, f2 as usize, 0, Move::DOUBLE_STEP, PAWN, 0));
                            }
                        }
                    }
                }
                let mut caps = patt[from] & enemy & mask;
                while caps != 0 {
                    let to = pop_lsb(&mut caps);
                    let victim = self.kind_at(to);
                    if promo_cells & bit(to) != 0 {
                        push_promotions(list, from, to, Move::CAPTURE, victim);
                    } else {
                        list.push(Move::new(from, to, 0, Move::CAPTURE, PAWN, victim));
                    }
                }
            }
            self.gen_en_passant::<LEGAL>(list);
        }
    }

    /// En-passant captures (verified by recomputing the attacks on the king when LEGAL).
    #[inline]
    fn gen_en_passant<const LEGAL: bool>(&self, list: &mut MoveList) {
        let Some(ep) = self.ep_capture_cell() else { return };
        let us = self.side;
        let mut froms = self.variant.pawn_attacks(us ^ 1, ep) & self.by_kind[PAWN] & self.by_color[us];
        while froms != 0 {
            let from = pop_lsb(&mut froms);
            if !LEGAL || self.en_passant_is_legal(from, ep) {
                list.push(Move::new(from, ep, 0, Move::CAPTURE | Move::EN_PASSANT, PAWN, PAWN));
            }
        }
    }

    fn en_passant_is_legal(&self, from: usize, ep: usize) -> bool {
        let us = self.side;
        if self.king[us] == NO_CELL {
            return true;
        }
        let them = us ^ 1;
        let ksq = self.king[us] as usize;
        let capsq = PAWN_PUSH[them][ep] as usize;
        let occ = (self.occupied() ^ bit(from) ^ bit(capsq)) | bit(ep);
        self.attackers_to(ksq, them, occ) & !bit(capsq) == 0
    }

    // -- perft --------------------------------------------------------------------------

    /// Number of leaf nodes at `depth` (bulk counting at depth 1).
    pub fn perft(&mut self, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut list = MoveList::new();
        self.gen_legal(&mut list);
        if depth == 1 {
            return list.len() as u64;
        }
        let mut nodes = 0;
        for &mv in list.iter() {
            let undo = self.make(mv);
            nodes += self.perft(depth - 1);
            self.unmake(mv, &undo);
        }
        nodes
    }

    /// Perft without bulk counting (every leaf is made and unmade).
    pub fn perft_full(&mut self, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut list = MoveList::new();
        self.gen_legal(&mut list);
        let mut nodes = 0;
        for &mv in list.iter() {
            let undo = self.make(mv);
            nodes += self.perft_full(depth - 1);
            self.unmake(mv, &undo);
        }
        nodes
    }

    /// Perft split by root move.
    pub fn perft_divide(&mut self, depth: u32) -> Vec<(Move, u64)> {
        let list = self.legal_moves();
        let mut out = Vec::with_capacity(list.len());
        for &mv in list.iter() {
            let undo = self.make(mv);
            let n = if depth <= 1 { 1 } else { self.perft(depth - 1) };
            self.unmake(mv, &undo);
            out.push((mv, n));
        }
        out
    }
}
