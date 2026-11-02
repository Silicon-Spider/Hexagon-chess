//! Perft (SPEC §2.4).
mod common;

use common::*;
use hexchess_engine::*;

fn perft(variant: Variant, depth: u32) -> u64 {
    Position::start(variant).perft(depth)
}

#[test]
fn glinski_perft_matches_published_numbers() {
    assert_eq!(perft(Variant::Glinski, 1), 51);
    assert_eq!(perft(Variant::Glinski, 2), 2_586);
    assert_eq!(perft(Variant::Glinski, 3), 137_858);
    // Without bulk counting too.
    assert_eq!(Position::start(Variant::Glinski).perft_full(3), 137_858);
}

#[test]
fn mccooey_perft_matches_published_numbers() {
    assert_eq!(perft(Variant::McCooey, 1), 31);
    assert_eq!(perft(Variant::McCooey, 2), 947);
    assert_eq!(perft(Variant::McCooey, 3), 33_307);
    // d4 = 1,157,852 (SPEC §2.4), agreed by this engine, tools/reference/hexref.mjs and two
    // throwaway implementations with identical per-root-move divides. The one published
    // figure, 1,157,856, predates its author's fix of a "phantom en passant" bug (SPEC §2.4
    // erratum): re-creating that bug in the reference reproduces 1,157,856 exactly.
    assert_eq!(perft(Variant::McCooey, 4), 1_157_852);
}

#[test]
fn depth_one_breakdowns() {
    let count = |v: Variant| {
        let p = Position::start(v);
        let mut by_kind = [0usize; 7];
        let (mut single, mut double) = (0, 0);
        for m in p.legal_moves().iter() {
            by_kind[m.piece()] += 1;
            if m.piece() == PAWN {
                if m.is_double_step() {
                    double += 1;
                } else {
                    single += 1;
                }
            }
        }
        (by_kind, single, double)
    };
    // Gliński: 17 pawn (9 single + 8 double), 8 knight, 12 bishop, 6 queen, 2 king, 6 rook.
    let (k, s, d) = count(Variant::Glinski);
    assert_eq!((s, d), (9, 8));
    assert_eq!(k, [0, 17, 8, 12, 6, 6, 2]);
    // McCooey: 13 pawn (7 single + 6 double), 10 knight, 8 bishop.
    let (k, s, d) = count(Variant::McCooey);
    assert_eq!((s, d), (7, 6));
    assert_eq!(k, [0, 13, 10, 8, 0, 0, 0]);
}

#[test]
fn divide_sums_to_perft() {
    for v in Variant::ALL {
        let mut p = Position::start(v);
        let div = p.perft_divide(3);
        assert_eq!(div.iter().map(|d| d.1).sum::<u64>(), perft(v, 3));
        assert_eq!(p, Position::start(v), "perft must restore the position");
    }
}

#[test]
fn print_deeper_perft_for_the_record() {
    for (v, depths) in [(Variant::Glinski, 4..=5), (Variant::McCooey, 4..=5)] {
        for depth in depths {
            let t0 = clock_ms();
            let n = perft(v, depth);
            let ms = clock_ms() - t0;
            println!(
                "{} perft({depth}) = {n} in {ms:.0} ms ({:.1} M nodes/s, bulk-counted)",
                v.name(),
                n as f64 / (ms.max(0.001) * 1000.0)
            );
            if depth == 4 && v == Variant::Glinski {
                assert_eq!(n, 7_282_418, "Gliński perft(4) (cross-checked with the independent reference)");
            }
        }
    }
    let t0 = clock_ms();
    let n = Position::start(Variant::Glinski).perft_full(4);
    let ms = clock_ms() - t0;
    println!("Gliński perft_full(4) = {n} in {ms:.0} ms ({:.1} M nodes/s, every leaf made)", n as f64 / (ms.max(0.001) * 1000.0));
    assert_eq!(n, 7_282_418);
}

/// Legal generation equals pseudo-legal generation filtered by make + king test, on the
/// positions reached after two plies in both variants and on tricky fixtures.
#[test]
fn legal_equals_filtered_pseudo_legal() {
    let check = |p: &mut Position| {
        let legal = p.legal_moves();
        let mut pseudo = MoveList::new();
        p.gen_pseudo(&mut pseudo);
        let filtered: Vec<Move> = pseudo.iter().copied().filter(|&m| p.is_legal(m)).collect();
        assert_eq!(sorted_codes(&legal), sorted_codes(&filtered), "{}", p.to_fen());
        let mut noisy = MoveList::new();
        p.gen_legal_noisy(&mut noisy);
        let expect: Vec<Move> = legal.iter().copied().filter(|m| m.is_noisy()).collect();
        assert_eq!(sorted_codes(&noisy), sorted_codes(&expect), "{}", p.to_fen());
    };
    for v in Variant::ALL {
        let mut p = Position::start(v);
        for m1 in p.legal_moves().iter().copied() {
            let u1 = p.make(m1);
            check(&mut p);
            for m2 in p.legal_moves().iter().copied() {
                let u2 = p.make(m2);
                check(&mut p);
                p.unmake(m2, &u2);
            }
            p.unmake(m1, &u1);
        }
    }
    let fixtures = [
        fen("Ka5 Pb5 re5 kl1 pc5", "w c6 0 1"),    // e.p. would expose the king
        fen("Kf6 Bf7 rf10 kl1 nc5 pe7", "w - 0 1"), // pinned bishop; knight c5 checks f6
        fen("Kf6 Qa1 rf10 nc5 kl1 bk7", "w - 0 1"), // double check (rook + knight)
        fen("Kf1 Rf3 Nf4 rf10 kl6 bc4", "w - 0 1"), // bishop check along c4-d3-e2-f1
        fen("Kf6 Rf8 Bh5 Nd5 rf11 bk2 nh4 kl1", "w - 0 1"), // several pins, no check
    ];
    for f in fixtures {
        let mut p = Position::from_fen_relaxed(&f, Variant::Glinski).unwrap();
        check(&mut p);
        let mut p = Position::from_fen_relaxed(&f, Variant::McCooey).unwrap();
        check(&mut p);
    }
}
