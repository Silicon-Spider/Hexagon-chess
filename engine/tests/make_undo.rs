//! make/unmake, Zobrist hashing and FEN consistency over seeded random playouts.
mod common;

use common::*;
use hexchess_engine::*;

/// Picks a move, biased towards pawn moves, captures, promotions and en passant so that the
/// playouts exercise the special cases.
fn choose(rng: &mut Rng, legal: &MoveList) -> Move {
    let pick = |rng: &mut Rng, pred: &dyn Fn(&Move) -> bool| -> Option<Move> {
        let c: Vec<Move> = legal.iter().copied().filter(|m| pred(m)).collect();
        if c.is_empty() {
            None
        } else {
            Some(c[rng.below(c.len())])
        }
    };
    let r = rng.below(100);
    if r < 20 {
        if let Some(m) = pick(rng, &|m| m.is_en_passant() || m.is_promotion()) {
            return m;
        }
    }
    if r < 60 {
        if let Some(m) = pick(rng, &|m| m.piece() == PAWN) {
            return m;
        }
    }
    if r < 75 {
        if let Some(m) = pick(rng, &|m| m.is_capture()) {
            return m;
        }
    }
    legal[rng.below(legal.len())]
}

#[derive(Default, Debug)]
struct Stats {
    plies: u64,
    captures: u64,
    en_passant: u64,
    promotions: u64,
    under_promotions: u64,
    double_steps: u64,
    checks: u64,
    null_moves: u64,
}

#[test]
fn random_playouts_restore_fen_and_hash_exactly() {
    let mut stats = Stats::default();
    for v in Variant::ALL {
        let mut rng = Rng(0xC0FF_EE00_1234_5678 ^ (v as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        for _game in 0..40 {
            let mut p = Position::start(v);
            let mut stack: Vec<(Move, Undo, Position)> = Vec::new();
            for _ply in 0..400 {
                let legal = p.legal_moves();
                if legal.is_empty() {
                    break;
                }
                // Legal generation == pseudo-legal generation filtered by make + king test.
                let mut pseudo = MoveList::new();
                p.gen_pseudo(&mut pseudo);
                let mut scratch = p.clone();
                let filtered: Vec<Move> = pseudo.iter().copied().filter(|&m| scratch.is_legal(m)).collect();
                assert_eq!(sorted_codes(&legal), sorted_codes(&filtered), "{}", p.to_fen());
                assert_eq!(scratch, p, "is_legal must restore the position");

                // Null move (only when not in check).
                if !p.in_check() {
                    let before = p.clone();
                    let u = p.make_null();
                    assert_eq!(p.hash(), p.compute_hash());
                    assert_ne!(p.side_to_move(), before.side_to_move());
                    p.unmake_null(&u);
                    assert_eq!(p, before);
                    stats.null_moves += 1;
                }

                let mv = choose(&mut rng, &legal);
                let before = p.clone();
                let undo = p.make(mv);
                assert_eq!(p.hash(), p.compute_hash(), "incremental hash after {mv} from {}", before.to_fen());
                // The new position survives a FEN round trip bit for bit (incl. hash and ep).
                let fen = p.to_fen();
                let parsed = Position::from_fen(&fen, v).unwrap_or_else(|e| panic!("{fen}: {e}"));
                assert_eq!(parsed, p, "{fen}");
                // Undo restores everything, then replay.
                p.unmake(mv, &undo);
                assert_eq!(p, before);
                assert_eq!(p.to_fen(), before.to_fen());
                assert_eq!(p.hash(), before.hash());
                let undo = p.make(mv);

                stats.plies += 1;
                stats.captures += mv.is_capture() as u64;
                stats.en_passant += mv.is_en_passant() as u64;
                stats.promotions += mv.is_promotion() as u64;
                stats.under_promotions += (mv.is_promotion() && mv.promo() != QUEEN) as u64;
                stats.double_steps += mv.is_double_step() as u64;
                stats.checks += p.in_check() as u64;
                stack.push((mv, undo, before));
            }
            while let Some((mv, undo, before)) = stack.pop() {
                p.unmake(mv, &undo);
                assert_eq!(p, before);
            }
            assert_eq!(p, Position::start(v));
        }
    }
    println!("{stats:?}");
    assert!(stats.plies > 10_000, "{stats:?}");
    assert!(stats.en_passant > 0, "{stats:?}");
    assert!(stats.promotions > 0 && stats.under_promotions > 0, "{stats:?}");
    assert!(stats.double_steps > 0 && stats.captures > 0 && stats.checks > 0, "{stats:?}");
}

#[test]
fn game_level_undo_restores_history_and_status() {
    for v in Variant::ALL {
        let mut rng = Rng(0xABCD_EF01 + v as u64);
        for _ in 0..10 {
            let mut game = Game::new(v);
            let mut fens = vec![game.fen()];
            while game.status() == Status::Ongoing && game.history().len() < 300 {
                let legal = game.legal_moves();
                let mv = choose(&mut rng, &legal);
                // Flags are ignored when matching a submitted move.
                assert!(game.make_move(Move(mv.key())));
                assert_eq!(game.history().last().unwrap().mv, mv);
                assert_eq!(game.hash_history().len(), game.history().len() + 1);
                assert_eq!(*game.hash_history().last().unwrap(), game.position().hash());
                fens.push(game.fen());
            }
            while game.undo() {
                fens.pop();
                assert_eq!(&game.fen(), fens.last().unwrap());
            }
            assert_eq!(fens.len(), 1);
            assert_eq!(game.fen(), v.start_fen());
            assert_eq!(game.hash_history().len(), 1);
            assert!(!game.undo());
        }
    }
}
