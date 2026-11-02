//! Computer opponent (SPEC §7 hc_search / hc_search_info_ptr, §10): tactics (mates, hanging
//! pieces, threats), stalemate scoring per variant, draw rules inside the search, limits,
//! determinism, noise, the info buffer and no mutation of the game.
//!
//! Test positions were found by a brute-force generator and every property a test relies
//! on (mate in n, stalemate, undefended queen …) is re-verified here with the rules core.
mod common;

use common::*;
use hexchess_engine::eval::PIECE_VALUE;
use hexchess_engine::geometry::*;
use hexchess_engine::search::{search, SearchLimits, SearchResult, MATE_SCORE, STALEMATE_VALUE};
use hexchess_engine::*;

const G: Variant = Variant::Glinski;
const M: Variant = Variant::McCooey;

fn depth(d: u32) -> SearchLimits {
    SearchLimits { max_depth: d, time_ms: 0, noise_cp: 0, seed: 0 }
}

fn game(fen: &str, v: Variant) -> Game {
    Game::from_fen(fen, v).unwrap_or_else(|e| panic!("{fen}: {e}"))
}

fn is_mate(p: &Position) -> bool {
    p.in_check() && !p.has_legal_move()
}

fn is_stalemate(p: &Position) -> bool {
    !p.in_check() && !p.has_legal_move()
}

fn after(p: &Position, mv: Move) -> Position {
    let mut q = p.clone();
    q.make(mv);
    q
}

/// Brute force: the side to move can force mate within `n` of its own moves.
fn mate_in(p: &mut Position, n: u32) -> bool {
    !mating_starts(p, n).is_empty()
}

/// Brute force: the moves that start a forced mate within `n` moves.
fn mating_starts(p: &mut Position, n: u32) -> Vec<Move> {
    let mut out = Vec::new();
    for &m in p.legal_moves().iter() {
        let u = p.make(m);
        let replies = p.legal_moves();
        let ok = if replies.is_empty() {
            p.in_check()
        } else if n <= 1 {
            false
        } else {
            replies.iter().all(|&r| {
                let u2 = p.make(r);
                let ok = mate_in(p, n - 1);
                p.unmake(r, &u2);
                ok
            })
        };
        p.unmake(m, &u);
        if ok {
            out.push(m);
        }
    }
    out
}

/// The colour-swapped mirror image (same file, rank from the other end) of a position.
fn mirror(p: &Position) -> Position {
    let mut t = Vec::new();
    for c in 0..NUM_CELLS {
        let code = p.piece_at(c);
        if code != 0 {
            let f = CELL_FILE[c] as usize;
            let mc = FILE_OFFSET[f] as usize + FILE_LEN[f] as usize - CELL_RANK[c] as usize;
            let letter = b"?PNBRQK"[code.unsigned_abs() as usize] as char;
            let ch = if code > 0 { letter.to_ascii_lowercase() } else { letter };
            t.push(format!("{ch}{}", cell_name(mc)));
        }
    }
    let side = if p.side_to_move() == WHITE { "b" } else { "w" };
    pos(&t.join(" "), &format!("{side} - 0 1"), p.variant())
}

/// White material minus Black material.
fn material(p: &Position) -> i32 {
    (PAWN..=QUEEN).map(|k| PIECE_VALUE[k] * (p.pieces(WHITE, k).count_ones() as i32 - p.pieces(BLACK, k).count_ones() as i32)).sum()
}

/// The PV is a legal move sequence from the current position starting with the best move.
fn assert_pv_legal(game: &Game, r: &SearchResult) {
    assert!(!r.info.pv.is_empty() && r.info.pv.len() <= 32, "{:?}", r.info.pv);
    assert_eq!(r.info.pv[0], r.best);
    let mut g = game.clone();
    for &m in &r.info.pv {
        assert!(g.make_move(m), "PV move {m} illegal in {}", g.fen());
    }
}

fn san(game: &Game, mv: Move) -> String {
    game.san(mv).unwrap_or_else(|| format!("<illegal {mv}>"))
}

// ---------------------------------------------------------------------------------------
// Mates

#[test]
fn mate_in_one_both_variants_and_colours() {
    let cases = [
        (G, "1/3/5/1P5/9/k5n2R1/3Q7/10p/6p4/8K2/4P6 w - 0 1", "Qc6#"),
        (G, "1/3/2q2/7/3r5/2PB7/2p1P6/11/6k1p2/11/10K b - 0 1", "Qf1#"),
        (M, "K/3/5/k4Pp/9/11/11/4Q5R/3p5n1/7P3/11 w - 0 1", "Qc6#"),
        (M, "1/3/kP3/7/2n6/3QR6/11/3K3p3/5p5/4P6/11 w - 0 1", "e10=Q#"),
        (M, "1/2K/5/2r4/4p4/7p3/7q3/11/9kP/P10/1B9 b - 0 1", "Qe10#"),
    ];
    for (v, fen, expect) in cases {
        let g = game(fen, v);
        let mut p = g.position().clone();
        let starts = mating_starts(&mut p, 1);
        assert_eq!(starts.len(), 1, "{fen}: exactly one mating move");
        for d in [1, 2, 4] {
            let r = search(&g, &depth(d));
            assert_eq!(san(&g, r.best), expect, "{fen} depth {d}");
            assert_eq!(r.best, starts[0]);
            assert!(is_mate(&after(g.position(), r.best)));
            assert_eq!(r.info.score, MATE_SCORE - 1, "{fen}");
            assert_pv_legal(&g, &r);
        }
    }
}

#[test]
fn mate_in_two_both_variants_and_colours() {
    let cases = [
        (G, "1/3/3p1/7/8Q/11/4R2K3/11/7p3/3k7/11 w - 0 1"), // 1. Qb3 (quiet)
        (G, "p/3/5/7/8p/11/6B4/8R2/8p2/NK9/3k7 w - 0 1"),   // 1. Nd3 (quiet knight move)
        (M, "Q/3/5/4p2/8p/11/6K4/11/8k2/1R9/11 w - 0 1"),   // 1. Ql1+
        (M, "1/R2/5/p3B2/9/5p5/11/p10/4N2K3/11/10k w - 0 1"), // 1. Ki3 (quiet king move)
    ];
    for (v, fen) in cases {
        let white = game(fen, v);
        // The same problem with colours swapped (Black to move) must be solved too.
        let black = Game::from_position(mirror(white.position()));
        for g in [&white, &black] {
            let mut p = g.position().clone();
            assert!(!mate_in(&mut p, 1), "{}: no mate in one", g.fen());
            let starts = mating_starts(&mut p, 2);
            assert!(!starts.is_empty(), "{}: mate in two", g.fen());
            let r = search(g, &depth(6));
            assert!(starts.contains(&r.best), "{}: {} does not mate in two", g.fen(), san(g, r.best));
            assert_eq!(r.info.score, MATE_SCORE - 3, "{}", g.fen());
            assert_pv_legal(g, &r);
            // The PV is the mating line itself.
            assert_eq!(r.info.pv.len(), 3, "{:?}", r.info.pv);
            let mut q = g.clone();
            for &m in &r.info.pv {
                assert!(q.make_move(m));
            }
            assert_eq!(q.status(), Status::Checkmate);
        }
    }
}

#[test]
fn glinski_prefers_mate_over_stalemate() {
    for fen in [
        "1/3/5/7/9/8R2/11/4Q6/K10/11/5k5 w - 0 1", // Ri2 stalemates, Qf3# mates
        "1/3/5/7/9/4Q6/11/8K2/11/9R1/5k5 w - 0 1", // six stalemating moves, Qe1# mates
    ] {
        let g = game(fen, G);
        let moves = g.legal_moves();
        assert!(moves.iter().any(|&m| is_stalemate(&after(g.position(), m))), "{fen}: a stalemate is available");
        for d in [1, 3, 5] {
            let r = search(&g, &depth(d));
            assert!(is_mate(&after(g.position(), r.best)), "{fen} depth {d}: {}", san(&g, r.best));
            assert_eq!(r.info.score, MATE_SCORE - 1);
        }
    }
}

#[test]
fn mccooey_does_not_stalemate_when_it_can_win() {
    // Each position has a capture that stalemates Black (a draw in McCooey) while White
    // has a forced mate; the engine must neither stalemate nor settle for less than mate.
    for fen in [
        "1/3/5/7/9/11/3K7/1Q9/10P/4R2p3/10k w - 0 1", // Qxh2 stalemates
        "1/3/5/4P2/9/5p5/k10/5K5/1Q9/11/10R w - 0 1", // Rxf6 stalemates
        "1/3/4k/7/9/9R1/7K3/6Q4/11/11/11 w - 0 1",    // Qe7 / Qg6 stalemate, Qg9# mates
    ] {
        let g = game(fen, M);
        assert!(g.legal_moves().iter().any(|&m| is_stalemate(&after(g.position(), m))), "{fen}");
        let r = search(&g, &depth(6));
        assert!(!is_stalemate(&after(g.position(), r.best)), "{fen}: {} stalemates", san(&g, r.best));
        assert!(r.info.score > MATE_SCORE - 10, "{fen}: score {}", r.info.score);
    }
}

#[test]
fn stalemate_is_scored_per_variant() {
    // White's king takes the rook on f3; Black (king f1, pawn f4 blocked) is then stalemated.
    // Any other move leaves White a rook down, so stalemating is best in both variants:
    // worth STALEMATE_VALUE under Gliński's 3/4 rule, a plain draw (0) in McCooey.
    let fen = "1/3/5/7/9/4P6/9P1/5p5/5rK4/11/2P2k5 w - 0 1";
    for (v, expect) in [(G, STALEMATE_VALUE), (M, 0)] {
        let g = game(fen, v);
        let r = search(&g, &depth(5));
        assert_eq!(san(&g, r.best), "Kxf3", "{v:?}");
        assert!(is_stalemate(&after(g.position(), r.best)));
        assert_eq!(r.info.score, expect, "{v:?}");
    }
    // The stalemated side scores -STALEMATE_VALUE: Black to move after Kxf3 is stalemated,
    // so the game is over and search returns no move.
    let mut g = game(fen, G);
    assert!(g.play("Kxf3").is_some());
    assert_eq!(g.status(), Status::Stalemate);
    assert!(search(&g, &depth(3)).best.is_none());
}

// ---------------------------------------------------------------------------------------
// Material tactics

#[test]
fn captures_a_hanging_queen() {
    let cases = [
        // Gliński: only the e4 pawn can take on d4 (pawns capture NW / NE).
        (G, "Kg1 Rc1 Ri1 Nh1 Bf1 Pb1 Pc2 Pe4 Pf5 Pg4 Ph3 Pi2 kg10 qd4 rc8 ri8 bf10 pb7 pc7 pe7 pf7 pg7 ph7 pi7", 1),
        // McCooey: the e3 pawn (pawns capture NNW / NNE) and the e2 knight can take on d4.
        (M, "Kg1 Rd1 Rh1 Ne2 Bf1 Pc1 Pd2 Pe3 Pf4 Pg3 Ph2 Pi1 kg10 qd4 rd9 rh9 bf10 pc8 pd8 pe8 pf8 pg8 ph8 pi8", 2),
    ];
    for (v, pieces, captures) in cases {
        let g = Game::from_position(pos(pieces, "w - 0 1", v));
        let q = cell("d4");
        assert_eq!(g.position().attackers_to(q, BLACK, g.position().occupied()), 0, "the queen is undefended");
        assert_eq!(g.legal_moves().iter().filter(|m| m.captured() == QUEEN).count(), captures);
        // The material is not balanced; winning the queen must lift the score by about 900.
        let balance = material(g.position());
        for d in [1, 2, 4] {
            let r = search(&g, &depth(d));
            assert_eq!(r.best.captured(), QUEEN, "{v:?} depth {d}: {}", san(&g, r.best));
            assert!(r.info.score > balance + 650, "{v:?}: score {} with material {balance}", r.info.score);
        }
        // Also with a time limit.
        let r = search(&g, &SearchLimits { max_depth: 0, time_ms: 200, noise_cp: 0, seed: 0 });
        assert_eq!(r.best.captured(), QUEEN, "{v:?} timed: {}", san(&g, r.best));
    }
}

#[test]
fn escapes_a_threat_to_its_queen() {
    let cases = [
        // Gliński: the black e7 pawn attacks the white queen on d6 (Black captures SW / SE).
        (G, "Kg1 Qd6 Rc1 Nh1 Pb1 Pc2 Pe4 Pf5 Pg4 kg10 qe10 rc8 bf9 pb7 pc7 pe7 pf7 pg7 ph7"),
        // McCooey: the black e8 pawn attacks the white queen on d6 (Black captures SSW / SSE).
        (M, "Kg1 Qd6 Rd1 Rh1 Pc1 Pd2 Pf4 Pg3 kg10 qe10 rd9 bf10 pc8 pe8 pf8 pg8 ph8"),
    ];
    for (v, pieces) in cases {
        let mut g = Game::from_position(pos(pieces, "w - 0 1", v));
        let qcell = cell("d6");
        let pawn_attackers = g.position().attackers_to(qcell, BLACK, g.position().occupied()) & g.position().pieces(BLACK, PAWN);
        assert_ne!(pawn_attackers, 0, "{v:?}: the queen is attacked by a pawn");
        let before = material(g.position());
        let r = search(&g, &depth(5));
        assert!(g.make_move(r.best));
        let reply = search(&g, &depth(5));
        assert!(g.make_move(reply.best));
        let after = material(g.position());
        assert!(after >= before - 150, "{v:?}: {} then {} lost material ({before} -> {after})", r.best, reply.best);
        assert_eq!(g.position().pieces(WHITE, QUEEN).count_ones(), 1, "{v:?}: queen saved");
    }
}

#[test]
fn static_exchange_evaluation() {
    use hexchess_engine::search::see_ge;
    let mv = |p: &Position, text: &str| notation::parse_move(p, text).unwrap_or_else(|| panic!("{text}"));
    // Gliński: e4xd4 wins a knight defended by the e5 pawn (Black recaptures SW): +200.
    let p = pos("Kg1 Pe4 kg10 nd4 pe5", "w - 0 1", G);
    let m = mv(&p, "exd4");
    assert!(see_ge(&p, m, 0) && see_ge(&p, m, 200) && !see_ge(&p, m, 201));
    // A queen taking a pawn defended by a pawn loses 800.
    let p = pos("Kg1 Qd1 kg10 pd4 pe5", "w - 0 1", G);
    let m = mv(&p, "Qxd4");
    assert!(!see_ge(&p, m, 0) && see_ge(&p, m, -800) && !see_ge(&p, m, -799));
    // X-ray: the d1 rook backs up Rd2xd4 against the d9 rook, so the pawn is won (+100);
    // without the second rook the capture loses the exchange (-400).
    let p = pos("Kg1 Rd1 Rd2 kg10 pd4 rd9", "w - 0 1", G);
    let m = mv(&p, "Rxd4");
    assert!(see_ge(&p, m, 100) && !see_ge(&p, m, 101));
    let p = pos("Kg1 Rd2 kg10 pd4 rd9", "w - 0 1", G);
    let m = mv(&p, "Rxd4");
    assert!(see_ge(&p, m, -400) && !see_ge(&p, m, -399));
    // McCooey: e3xd4 (pawns capture NNW / NNE) against a knight defended by the e6 pawn
    // (Black recaptures SSW): +200.
    let p = pos("Kg1 Pe3 kg10 nd4 pe6", "w - 0 1", M);
    let m = mv(&p, "exd4");
    assert!(see_ge(&p, m, 200) && !see_ge(&p, m, 201));
}

// ---------------------------------------------------------------------------------------
// Draw rules inside the search

#[test]
fn perpetual_check_saves_a_lost_position() {
    // Black (queen against queen, two rooks and pawns) draws by repeating checks: an in-search
    // repetition scores 0.
    for (v, fen) in [
        (G, "1/3/5/7/1R7/2q8/1Q2P6/11/2R8/11/1P1k3K3 b - 0 1"),
        (M, "1/3/5/3P3/9/4R2P1Q1/11/11/11/K1k1q6/8R2 b - 0 1"),
    ] {
        let g = game(fen, v);
        assert!(material(g.position()) > 1000);
        let r = search(&g, &depth(7));
        assert_eq!(r.info.score, 0, "{v:?}: {}", san(&g, r.best));
        assert!(g.position().clone().gives_check(r.best), "{v:?}: {} checks", san(&g, r.best));
    }
}

#[test]
fn repetition_of_a_game_position_counts_as_a_draw() {
    // White (lone rook) is lost, but the game history makes one rook move lead back to a
    // position that already occurred: the search scores that move as a draw.
    for v in Variant::ALL {
        let f = fen("Ka1 Rk1 kf11 qe6 rd8", "w - 0 1");
        let fresh = game(&f, v);
        let lost = search(&fresh, &depth(4));
        assert!(lost.info.score < -300, "{v:?}: White is lost ({})", lost.info.score);
        let mut g = game(&f, v);
        for m in ["Rk2", "Ke10", "Rk1", "Kf11"] {
            assert!(g.play(m).is_some(), "{v:?} {m}");
        }
        assert_eq!(g.position().board(), fresh.position().board());
        assert_eq!(g.status(), Status::Ongoing);
        let r = search(&g, &depth(4));
        assert_eq!(san(&g, r.best), "Rk2", "{v:?}");
        assert_eq!(r.info.score, 0, "{v:?}");
    }
}

#[test]
fn fifty_move_rule_inside_the_search() {
    // Clock 99: every quiet move ends the game in a draw unless it mates.
    let g = game(&fen("Ka1 kf11 Qh8", "w - 99 80"), G);
    let r = search(&g, &depth(4));
    assert_eq!(san(&g, r.best), "Qf9#", "a mate on the 100th ply still wins");
    assert_eq!(r.info.score, MATE_SCORE - 1);
    // Without a mate (or stalemate) in one, every move scores 0.
    for v in Variant::ALL {
        let g = game(&fen("Ka1 kf11 Qb2", "w - 99 80"), v);
        assert!(g.legal_moves().iter().all(|&m| after(g.position(), m).has_legal_move()), "{v:?}");
        let r = search(&g, &depth(4));
        assert!(!r.best.is_none());
        assert_eq!(r.info.score, 0, "{v:?}: {}", san(&g, r.best));
        // With a fresh clock the queen is simply winning.
        let fresh = game(&fen("Ka1 kf11 Qb2", "w - 0 80"), v);
        assert!(search(&fresh, &depth(4)).info.score > 500);
    }
}

#[test]
fn insufficient_material_inside_the_search() {
    // The black pawn promotes next move unless the knight takes it; taking it leaves K+N v K,
    // an exact draw by insufficient material.
    for v in Variant::ALL {
        let g = game(&fen("Ka1 Nf4 kl6 pi2", "w - 0 1"), v);
        let r = search(&g, &depth(5));
        assert_eq!(san(&g, r.best), "Nxi2", "{v:?}");
        assert_eq!(r.info.score, 0, "{v:?}");
    }
}

// ---------------------------------------------------------------------------------------
// Limits, termination, no mutation

#[test]
fn always_returns_a_legal_move_under_tiny_limits() {
    let mut rng = Rng(0x0A11_E6A1);
    for v in Variant::ALL {
        let mut g = Game::new(v);
        for ply in 0..120 {
            if g.status() != Status::Ongoing {
                break;
            }
            let legal = g.legal_moves();
            for lim in [
                SearchLimits { max_depth: 1, time_ms: 0, noise_cp: 0, seed: 0 },
                SearchLimits { max_depth: 0, time_ms: 1, noise_cp: 0, seed: 0 },
                SearchLimits { max_depth: 3, time_ms: 1, noise_cp: 0, seed: 0 },
                SearchLimits { max_depth: 2, time_ms: 0, noise_cp: 150, seed: ply },
            ] {
                let r = search(&g, &lim);
                assert!(legal.contains(&r.best), "{v:?} {lim:?} {}: {}", g.fen(), r.best);
                assert!(r.info.depth >= 1);
                assert_eq!(r.info.pv.first(), Some(&r.best));
            }
            let mv = legal[rng.below(legal.len())];
            assert!(g.make_move(mv));
        }
    }
}

#[test]
fn time_limit_is_respected() {
    // Warm up (the first search of a thread allocates the hash table).
    let _ = search(&Game::new(G), &depth(1));
    for v in Variant::ALL {
        let g = Game::new(v);
        for t in [1u32, 50, 300] {
            let t0 = clock_ms();
            let r = search(&g, &SearchLimits { max_depth: 0, time_ms: t, noise_cp: 0, seed: 0 });
            let took = clock_ms() - t0;
            assert!(!r.best.is_none());
            assert!(took < t as f64 + 150.0, "{v:?}: {t} ms limit took {took:.0} ms");
            assert!(r.info.elapsed_ms <= t + 150);
        }
        // Depth-bounded searches stop at the depth.
        let r = search(&g, &depth(3));
        assert_eq!(r.info.depth, 3);
    }
}

#[test]
fn returns_no_move_when_the_game_is_over() {
    let over = [
        // Checkmate (Gliński fool's mate).
        (G, "b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4".to_string(), Status::Checkmate),
        // Stalemate (both variants).
        (G, "k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1".to_string(), Status::Stalemate),
        (M, "k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1".to_string(), Status::Stalemate),
        // Insufficient material, fifty-move rule.
        (G, "k/3/5/7/9/11/11/11/11/11/K10 w - 0 1".to_string(), Status::DrawInsufficient),
        (M, fen("Kg1 Qe1 kg10", "w - 100 70"), Status::DrawFiftyMove),
    ];
    for (v, f, status) in over {
        let g = game(&f, v);
        assert_eq!(g.status(), status, "{f}");
        let r = search(&g, &depth(3));
        assert!(r.best.is_none(), "{f}");
        assert_eq!(r.info, Default::default());
        // Through the ABI as well.
        let h = hc_new(v as u32);
        let len = f.len() as u32;
        let buf = hc_alloc(len);
        // SAFETY: `buf` has `len` writable bytes.
        unsafe { std::ptr::copy_nonoverlapping(f.as_ptr(), buf, f.len()) };
        assert_eq!(hc_load_fen(h, buf, len), 1);
        hc_free(buf, len);
        assert_eq!(hc_search(h, 3, 100, 0, 0), 0, "{f}");
        // SAFETY: the info buffer holds 38 i32s.
        let info = unsafe { std::slice::from_raw_parts(hc_search_info_ptr(), 38) };
        assert!(info.iter().all(|&x| x == 0));
        hc_destroy(h);
    }
    // Threefold repetition (knight shuffles).
    for v in Variant::ALL {
        let mut g = Game::new(v);
        let knight_move = |p: &Position| p.legal_moves().iter().copied().find(|m| m.piece() == KNIGHT).unwrap();
        let w = knight_move(g.position());
        assert!(g.make_move(w));
        let b = knight_move(g.position());
        assert!(g.make_move(b));
        let back = |m: Move| Move::new(m.to(), m.from(), 0, 0, KNIGHT, 0);
        for m in [back(w), back(b), w, b, back(w), back(b)] {
            assert!(!search(&g, &depth(2)).best.is_none(), "{v:?}: ongoing until the third occurrence");
            assert!(g.make_move(m));
        }
        assert_eq!(g.status(), Status::DrawThreefold);
        assert!(search(&g, &depth(2)).best.is_none());
    }
}

#[test]
fn search_leaves_the_game_unchanged() {
    for v in Variant::ALL {
        let mut g = Game::new(v);
        let first = g.legal_moves()[0];
        assert!(g.make_move(first));
        let reply = g.legal_moves()[3];
        assert!(g.make_move(reply));
        let fen = g.fen();
        let hash = g.position().hash();
        let hashes = g.hash_history().to_vec();
        let hist: Vec<(u32, String)> = g.history().iter().map(|e| (e.mv.0, e.san.clone())).collect();
        let board = *g.position().board();
        for lim in [depth(4), SearchLimits { max_depth: 0, time_ms: 100, noise_cp: 0, seed: 0 }, SearchLimits { max_depth: 3, time_ms: 0, noise_cp: 90, seed: 7 }] {
            let r = search(&g, &lim);
            assert!(!r.best.is_none());
            assert_eq!(g.fen(), fen);
            assert_eq!(g.position().hash(), hash);
            assert_eq!(g.hash_history(), &hashes[..]);
            assert_eq!(g.history().iter().map(|e| (e.mv.0, e.san.clone())).collect::<Vec<_>>(), hist);
            assert_eq!(g.position().board(), &board);
            assert_eq!(g.status(), Status::Ongoing);
        }
    }
    // Through the ABI: FEN, board bytes, history length and the start FEN are untouched.
    let h = hc_new(1);
    let mv = hc_moves_ptr(h);
    assert!(!mv.is_null());
    let n = hc_gen_moves(h);
    // SAFETY: the buffer holds `n` moves.
    let first = unsafe { *hc_moves_ptr(h) };
    assert!(n > 0);
    assert_eq!(hc_make_move(h, first), 1);
    let read = |len: u32| -> String {
        // SAFETY: the engine wrote `len` bytes.
        String::from_utf8(unsafe { std::slice::from_raw_parts(hc_str_ptr(), len as usize) }.to_vec()).unwrap()
    };
    let fen_before = read(hc_fen(h));
    // SAFETY: 91 bytes.
    let board_before = unsafe { std::slice::from_raw_parts(hc_board_ptr(h), 91) }.to_vec();
    let best = hc_search(h, 4, 0, 0, 0);
    assert_ne!(best, 0);
    assert_eq!(read(hc_fen(h)), fen_before);
    assert_eq!(unsafe { std::slice::from_raw_parts(hc_board_ptr(h), 91) }.to_vec(), board_before);
    assert_eq!(hc_history_len(h), 1);
    assert_eq!(hc_make_move(h, best), 1, "the returned move is legal");
    hc_destroy(h);
}

#[test]
fn deterministic_at_fixed_depth() {
    for v in Variant::ALL {
        let mut g = Game::new(v);
        for _ in 0..6 {
            let r = search(&g, &depth(3));
            assert!(g.make_move(r.best));
        }
        let a = search(&g, &depth(6));
        // Unrelated searches in between (timed ones reuse the hash table) must not matter.
        let _ = search(&Game::new(v), &SearchLimits { max_depth: 0, time_ms: 60, noise_cp: 0, seed: 0 });
        let _ = search(&Game::new(G), &depth(5));
        let b = search(&g, &depth(6));
        assert_eq!(a.best, b.best, "{v:?}");
        assert_eq!(a.info.score, b.info.score);
        assert_eq!(a.info.pv, b.info.pv);
        assert_eq!(a.info.nodes, b.info.nodes);
        assert_eq!(a.info.depth, 6);
        assert_pv_legal(&g, &a);
    }
}

#[test]
fn noise_gives_legal_varied_and_reproducible_moves() {
    for v in Variant::ALL {
        let g = Game::new(v);
        let legal = g.legal_moves();
        for d in [1, 2] {
            let mut seen = Vec::new();
            for seed in 0..24 {
                let lim = SearchLimits { max_depth: d, time_ms: 0, noise_cp: 250, seed };
                let r = search(&g, &lim);
                assert!(legal.contains(&r.best));
                assert_eq!(search(&g, &lim).best, r.best, "same seed, same move");
                assert!(r.info.score.abs() < 400, "reported score is the un-noised one: {}", r.info.score);
                if !seen.contains(&r.best) {
                    seen.push(r.best);
                }
            }
            assert!(seen.len() >= 4, "{v:?} depth {d}: only {} distinct moves", seen.len());
        }
        // Level-3 settings (depth 3, 400 ms, noise 40) complete with a legal move.
        let r = search(&g, &SearchLimits { max_depth: 3, time_ms: 400, noise_cp: 40, seed: 3 });
        assert!(legal.contains(&r.best));
        assert!(r.info.depth >= 1);
    }
}

#[test]
fn info_buffer_layout() {
    let h = hc_new(0);
    let best = hc_search(h, 5, 0, 0, 0);
    assert_ne!(best, 0);
    // SAFETY: the info buffer holds 6 + 32 i32s.
    let info = unsafe { std::slice::from_raw_parts(hc_search_info_ptr(), 38) }.to_vec();
    assert_eq!(info[0], 5, "depth completed");
    assert!(info[1].abs() < 200, "opening score {}", info[1]);
    let nodes = info[2] as u32 as u64 | (info[3] as u32 as u64) << 32;
    assert!(nodes > 100);
    assert!(info[4] >= 0);
    let pv_len = info[5] as usize;
    assert!((1..=32).contains(&pv_len));
    assert_eq!(info[6] as u32, best);
    assert!(info[6 + pv_len..].iter().all(|&x| x == 0));
    // The PV replays legally through the ABI.
    for &m in &info[6..6 + pv_len] {
        assert_eq!(hc_make_move(h, m as u32), 1, "PV move {m}");
    }
    hc_destroy(h);
    // Mate scores: ±(30000 - plies), side-to-move point of view.
    let g = hc_new(0);
    for m in ["Qe1-c3", "Qe10-c6", "b1-b2", "b7-b6", "Bf3-b1", "e7-e6"] {
        let len = m.len() as u32;
        let buf = hc_alloc(len);
        // SAFETY: `buf` has `len` writable bytes.
        unsafe { std::ptr::copy_nonoverlapping(m.as_ptr(), buf, m.len()) };
        let code = hc_parse_move(g, buf, len);
        hc_free(buf, len);
        assert_eq!(hc_make_move(g, code), 1);
    }
    assert_ne!(hc_search(g, 3, 0, 0, 0), 0);
    // SAFETY: as above.
    let info = unsafe { std::slice::from_raw_parts(hc_search_info_ptr(), 38) };
    assert_eq!(info[1], 29999);
    assert_eq!(info[5], 1);
    hc_destroy(g);
}

#[test]
fn positions_without_a_king_do_not_break_the_search() {
    // Rule fixtures parsed with the relaxed FEN reader may lack a king; searching them (not
    // reachable through the ABI) must still return a legal move without panicking.
    for f in [
        "K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1",
        "K/3/5/3q3/2q6/11/11/11/11/11/11 w - 0 1",
        "k/3/5/7/9/5R5/11/11/11/11/11 b - 0 1",
        "1/3/5/7/9/5R5/11/11/11/11/11 w - 0 1",
    ] {
        for v in Variant::ALL {
            let g = Game::from_position(Position::from_fen_relaxed(f, v).unwrap());
            let legal = g.legal_moves();
            let r = search(&g, &depth(4));
            assert!(legal.contains(&r.best), "{v:?} {f}");
            let r = search(&g, &SearchLimits { max_depth: 0, time_ms: 30, noise_cp: 0, seed: 0 });
            assert!(legal.contains(&r.best), "{v:?} {f}");
        }
    }
}

// ---------------------------------------------------------------------------------------
// Self-play smoke test (run with `cargo test --release -- --ignored`)

/// Depth-3 against depth-1, five games with each colour per variant, the first two plies
/// random; checks that every move is legal and reports the score of the depth-3 side.
#[test]
#[ignore]
fn self_play_depth3_vs_depth1() {
    let mut rng = Rng(0x5E1F_91A7);
    for v in Variant::ALL {
        let (mut wins, mut draws, mut losses) = (0, 0, 0);
        let mut plies_total = 0;
        for game_no in 0..10 {
            let strong = if game_no % 2 == 0 { WHITE } else { BLACK };
            let mut g = Game::new(v);
            for _ in 0..2 {
                let legal = g.legal_moves();
                assert!(g.make_move(legal[rng.below(legal.len())]));
            }
            let mut plies = 2;
            while g.status() == Status::Ongoing && plies < 300 {
                let d = if g.position().side_to_move() == strong { 3 } else { 1 };
                let r = search(&g, &depth(d));
                assert!(!r.best.is_none(), "{v:?} {}", g.fen());
                assert!(g.make_move(r.best), "{v:?}: illegal {} in {}", r.best, g.fen());
                plies += 1;
            }
            plies_total += plies;
            let status = g.status();
            let loser = g.position().side_to_move();
            let result = match status {
                Status::Checkmate => if loser == strong { -1 } else { 1 },
                Status::Stalemate if v == G => if loser == strong { -1 } else { 1 },
                _ => 0,
            };
            match result {
                1 => wins += 1,
                -1 => losses += 1,
                _ => draws += 1,
            }
            println!("{v:?} game {game_no}: strong side {}, {status:?} after {plies} plies", if strong == WHITE { "White" } else { "Black" });
        }
        println!("{v:?}: depth 3 vs depth 1: +{wins} ={draws} -{losses} ({plies_total} plies)");
        assert!(wins > losses, "{v:?}");
    }
}
