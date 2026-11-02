//! Static evaluation (SPEC §10): symmetry, material, pawn terms, passed pawns, hc_eval POV.
mod common;

use common::*;
use hexchess_engine::eval::{self, evaluate, evaluate_stm, passed_pawns, PIECE_VALUE, TEMPO};
use hexchess_engine::geometry::*;
use hexchess_engine::variant::{PAWN_ATTACKS, PAWN_PUSH};
use hexchess_engine::*;

/// The cell mirrored across the board's horizontal axis (same file, rank counted from the
/// other end): a1 <-> a6, f1 <-> f11, g4 <-> g7.
fn mirror_cell(c: usize) -> usize {
    let f = CELL_FILE[c] as usize;
    let rank = CELL_RANK[c] as usize;
    FILE_OFFSET[f] as usize + FILE_LEN[f] as usize - rank
}

/// Piece tokens ("Kg1 pf7 …") of a position's board.
fn tokens(p: &Position) -> Vec<String> {
    let mut out = Vec::new();
    for c in 0..NUM_CELLS {
        let code = p.piece_at(c);
        if code != 0 {
            let letter = b"?PNBRQK"[code.unsigned_abs() as usize] as char;
            let ch = if code > 0 { letter } else { letter.to_ascii_lowercase() };
            out.push(format!("{ch}{}", cell_name(c)));
        }
    }
    out
}

/// A position with some pieces removed (by cell) and added (tokens), `side` to move.
fn edited(p: &Position, remove: &[&str], add: &[&str], side: &str) -> Position {
    let mut t: Vec<String> = tokens(p).into_iter().filter(|tok| !remove.contains(&&tok[1..])).collect();
    t.extend(add.iter().map(|s| s.to_string()));
    pos(&t.join(" "), &format!("{side} - 0 1"), p.variant())
}

/// The colour-swapped mirror image of a position (same variant, other side to move).
fn mirror(p: &Position) -> Position {
    let mut t = Vec::new();
    for c in 0..NUM_CELLS {
        let code = p.piece_at(c);
        if code != 0 {
            let letter = b"?PNBRQK"[code.unsigned_abs() as usize] as char;
            // Swap colours: white pieces become black and vice versa.
            let ch = if code > 0 { letter.to_ascii_lowercase() } else { letter };
            t.push(format!("{ch}{}", cell_name(mirror_cell(c))));
        }
    }
    let side = if p.side_to_move() == WHITE { "b" } else { "w" };
    pos(&t.join(" "), &format!("{side} - 0 1"), p.variant())
}

fn hc_eval_of(fen: &str, v: Variant) -> i32 {
    let g = hc_new(v as u32);
    let len = fen.len() as u32;
    let buf = hc_alloc(len);
    // SAFETY: `buf` has `len` writable bytes.
    unsafe { std::ptr::copy_nonoverlapping(fen.as_ptr(), buf, fen.len()) };
    assert_eq!(hc_load_fen(g, buf, len), 1, "{fen}");
    hc_free(buf, len);
    let e = hc_eval(g);
    hc_destroy(g);
    e
}

#[test]
fn start_positions_evaluate_to_zero() {
    for v in Variant::ALL {
        let p = Position::start(v);
        assert_eq!(evaluate(&p), 0, "{v:?}");
        assert_eq!(evaluate_stm(&p), TEMPO, "{v:?}: the side-to-move view adds the tempo bonus");
        assert_eq!(eval::phase(&p), eval::PHASE_MAX);
        assert_eq!(hc_eval_of(v.start_fen(), v), 0);
    }
}

#[test]
fn mirror_cell_is_an_involution_matching_the_start_setups() {
    for c in 0..NUM_CELLS {
        assert_eq!(mirror_cell(mirror_cell(c)), c);
        assert_eq!(CENTER_DIST[mirror_cell(c)], CENTER_DIST[c]);
    }
    assert_eq!(mirror_cell(cell("f1")), cell("f11"));
    assert_eq!(mirror_cell(cell("g1")), cell("g10"));
    assert_eq!(mirror_cell(cell("e4")), cell("e7"));
    for v in Variant::ALL {
        let p = Position::start(v);
        let board = |q: &Position| q.to_fen().split(' ').next().unwrap().to_string();
        assert_eq!(board(&mirror(&p)), board(&p), "{v:?} start is mirror-symmetric");
    }
}

/// The evaluation is exactly antisymmetric: mirroring the board and swapping the colours
/// negates it (checked on every position of random games in both variants).
#[test]
fn evaluation_is_colour_symmetric() {
    let mut rng = Rng(0x5EED_E7A1);
    let mut checked = 0;
    for v in Variant::ALL {
        for _game in 0..12 {
            let mut game = Game::new(v);
            for _ply in 0..160 {
                let p = game.position();
                let m = mirror(p);
                assert_eq!(evaluate(&m), -evaluate(p), "{} vs mirror {}", p.to_fen(), m.to_fen());
                assert_eq!(evaluate_stm(&m), evaluate_stm(p), "{}", p.to_fen());
                checked += 1;
                if game.status() != Status::Ongoing {
                    break;
                }
                let moves = game.legal_moves();
                // Prefer captures now and then so that endgames are reached too.
                let caps: Vec<Move> = moves.iter().copied().filter(|m| m.is_capture()).collect();
                let mv = if !caps.is_empty() && rng.below(3) == 0 { caps[rng.below(caps.len())] } else { moves[rng.below(moves.len())] };
                assert!(game.make_move(mv));
            }
        }
    }
    assert!(checked > 2000, "{checked}");
}

#[test]
fn material_dominates_and_hc_eval_is_white_pov() {
    for v in Variant::ALL {
        let start = Position::start(v);
        for side in ["w", "b"] {
            // Without the white queen (e1 in both setups) Black is about a queen up.
            let p = edited(&start, &["e1"], &[], side);
            let e = evaluate(&p);
            assert!((-PIECE_VALUE[QUEEN] - 250..-PIECE_VALUE[QUEEN] + 250).contains(&e), "{v:?} {side}: {e}");
            // hc_eval reports White's point of view whoever is to move.
            assert_eq!(hc_eval_of(&p.to_fen(), v), e);
            assert_eq!(evaluate_stm(&p), if side == "w" { e + TEMPO } else { -e + TEMPO });
            // Without a black knight White is ahead.
            let knight = if v == Variant::Glinski { "d9" } else { "e9" };
            let q = edited(&start, &[knight], &[], side);
            let e = evaluate(&q);
            assert!((PIECE_VALUE[KNIGHT] - 150..PIECE_VALUE[KNIGHT] + 150).contains(&e), "{v:?} {side}: {e}");
        }
    }
}

#[test]
fn phase_and_endgame_scaling() {
    let g = Variant::Glinski;
    let kk = pos("Kg1 kg10", "w - 0 1", g);
    assert_eq!(eval::phase(&kk), 0);
    assert_eq!(evaluate(&kk), 0);
    // A lone extra minor piece without pawns is scaled towards a draw.
    let kbk = pos("Kg1 Bf6 kg10", "w - 0 1", g);
    assert!(evaluate(&kbk).abs() < 60, "{}", evaluate(&kbk));
    // A rook is a real advantage; mop-up prefers the bare king on the edge.
    let edge = pos("Kf6 Rb1 kf11", "w - 0 1", g);
    let centre = pos("Kf2 Rb1 kf7", "w - 0 1", g);
    assert!(evaluate(&edge) > 400);
    assert!(evaluate(&edge) > evaluate(&centre), "{} vs {}", evaluate(&edge), evaluate(&centre));
}

#[test]
fn pawn_advancement_grows_towards_promotion() {
    for v in Variant::ALL {
        let ev = |rank: usize| evaluate(&pos(&format!("Ka1 Pf{rank} kl6"), "w - 0 1", v));
        // A lone white f-pawn walking up the f-file (kings far away on the a / l files).
        for rank in 2..10 {
            assert!(ev(rank + 1) > ev(rank), "{v:?} f{}: {} <= {}", rank + 1, ev(rank + 1), ev(rank));
        }
        // The last steps are worth much more than the first ones.
        assert!(ev(10) - ev(9) > 2 * (ev(4) - ev(3)), "{v:?}");
        assert!(ev(10) - ev(2) > 200, "{v:?}: {} vs {}", ev(10), ev(2));
    }
}

/// Brute-force definition of a passed pawn: no enemy pawn can ever (pushing straight
/// ahead) stand on the pawn's path or attack a cell of it (current cell included).
fn passed_by_definition(p: &Position, color: usize, sq: usize) -> bool {
    let v = p.variant() as usize;
    let mut path = vec![sq];
    let mut x = sq;
    while PAWN_PUSH[color][x] != NO_CELL {
        x = PAWN_PUSH[color][x] as usize;
        path.push(x);
    }
    for e in cells(p.pieces(color ^ 1, PAWN)) {
        let mut y = e;
        loop {
            if y != sq && path.contains(&y) {
                return false;
            }
            if path.iter().any(|&c| PAWN_ATTACKS[v][color ^ 1][y] & bit(c) != 0) {
                return false;
            }
            if PAWN_PUSH[color ^ 1][y] == NO_CELL {
                break;
            }
            y = PAWN_PUSH[color ^ 1][y] as usize;
        }
    }
    true
}

#[test]
fn passed_pawns_match_the_brute_force_definition() {
    let mut rng = Rng(0xFA55_ED01);
    let mut passed_seen = [0usize; 2];
    let mut not_passed_seen = 0usize;
    for v in Variant::ALL {
        for _ in 0..40 {
            let mut game = Game::new(v);
            for _ply in 0..120 {
                let p = game.position();
                for color in [WHITE, BLACK] {
                    let pp = passed_pawns(p, color);
                    for sq in cells(p.pieces(color, PAWN)) {
                        let expect = passed_by_definition(p, color, sq);
                        assert_eq!(pp & bit(sq) != 0, expect, "{v:?} {} pawn {}", p.to_fen(), cell_name(sq));
                        if expect {
                            passed_seen[v as usize] += 1;
                        } else {
                            not_passed_seen += 1;
                        }
                    }
                }
                if game.status() != Status::Ongoing {
                    break;
                }
                let moves = game.legal_moves();
                let caps: Vec<Move> = moves.iter().copied().filter(|m| m.is_capture()).collect();
                let mv = if !caps.is_empty() && rng.below(2) == 0 { caps[rng.below(caps.len())] } else { moves[rng.below(moves.len())] };
                assert!(game.make_move(mv));
            }
        }
    }
    assert!(passed_seen[0] > 100 && passed_seen[1] > 100 && not_passed_seen > 1000, "{passed_seen:?} {not_passed_seen}");
}

#[test]
fn passed_pawn_examples_per_variant() {
    // Gliński: Black pawns capture SW / SE. A black pawn on d8 attacks e8 (SE), on the
    // e5 pawn's path; one on c8 attacks b8 / d7, off the path.
    let g = Variant::Glinski;
    assert_eq!(passed_pawns(&pos("Kg1 Pe5 kg10 pd8", "w - 0 1", g), WHITE), 0);
    assert_eq!(passed_pawns(&pos("Kg1 Pe5 kg10 pc8", "w - 0 1", g), WHITE), bit(cell("e5")));
    // A black pawn already behind the white pawn does not matter.
    assert_eq!(passed_pawns(&pos("Kg1 Pe5 kg10 pd3", "w - 0 1", g), WHITE), bit(cell("e5")));
    // McCooey: Black pawns capture SSW / SSE (diagonally). A black pawn on f8 attacks e6
    // (SSW), in front of e5; one on c8 cannot reach the e-file's cells.
    let m = Variant::McCooey;
    assert_eq!(passed_pawns(&pos("Kg1 Pe5 kg10 pf8", "w - 0 1", m), WHITE), 0);
    assert_eq!(passed_pawns(&pos("Kg1 Pe5 kg10 pc8", "w - 0 1", m), WHITE), bit(cell("e5")));
    // Black's passed pawns use the mirrored geometry.
    assert_eq!(passed_pawns(&pos("Kg1 Pc4 kg10 pe7", "b - 0 1", m), BLACK), bit(cell("e7")));
    // A passed pawn is worth more than the same pawn facing an enemy pawn.
    let passed = evaluate(&pos("Kg1 Pe7 kg10 pc8", "w - 0 1", m));
    let stopped = evaluate(&pos("Kg1 Pe7 kg10 pf10", "w - 0 1", m));
    assert!(passed > stopped, "{passed} vs {stopped}");
}

#[test]
fn centralisation_and_king_safety_have_the_right_sign() {
    let g = Variant::Glinski;
    // A knight in the centre beats a knight on the edge.
    let centre = evaluate(&pos("Kg1 Nf6 Pb2 kg10 pf7", "w - 0 1", g));
    let edge = evaluate(&pos("Kg1 Na1 Pb2 kg10 pf7", "w - 0 1", g));
    assert!(centre > edge + 20, "{centre} vs {edge}");
    // In the middlegame a king walked to the middle of the board is worse than one at home.
    let start = Position::start(g);
    let walked = edited(&start, &["g1"], &["Kf6"], "w");
    assert!(evaluate(&start) > evaluate(&walked) + 30, "{} vs {}", evaluate(&start), evaluate(&walked));
    // In the endgame the king belongs in the centre.
    let central = evaluate(&pos("Kf6 Pb2 kf11 pk7", "w - 0 1", g));
    let corner = evaluate(&pos("Ka1 Pb2 kf11 pk7", "w - 0 1", g));
    assert!(central > corner + 30, "{central} vs {corner}");
}
