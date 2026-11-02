//! Board geometry (SPEC §1).
#![allow(clippy::needless_range_loop)]
mod common;

use common::*;
use hexchess_engine::geometry::*;
use hexchess_engine::*;

#[test]
fn ninety_one_cells_and_axial_bijection() {
    assert_eq!(NUM_CELLS, 91);
    assert_eq!(FILE_LEN.iter().map(|&l| l as usize).sum::<usize>(), 91);
    assert_eq!(ALL_CELLS.count_ones(), 91);
    let mut seen = [false; NUM_CELLS];
    let mut count = 0;
    for q in -6..=6 {
        for r in -6..=6 {
            match cell_at(q, r) {
                Some(c) => {
                    assert!(on_board(q, r));
                    assert!(!seen[c], "cell {c} produced twice");
                    seen[c] = true;
                    count += 1;
                    assert_eq!(cell_qr(c), (q, r));
                }
                None => assert!(!on_board(q, r)),
            }
        }
    }
    assert_eq!(count, 91);
}

#[test]
fn index_name_and_qr_round_trips() {
    for c in 0..NUM_CELLS {
        let name = cell_name(c);
        assert_eq!(parse_cell(&name), Some(c), "{name}");
        let (q, r) = cell_qr(c);
        assert_eq!(cell_at(q, r), Some(c));
        let file = CELL_FILE[c] as usize;
        let rank = CELL_RANK[c] as usize;
        assert_eq!(file as i32, q + 5);
        assert_eq!(rank as i32, 6 - r - q.max(0), "rank formula for {name}");
        assert_eq!(c, FILE_OFFSET[file] as usize + rank - 1);
        assert_eq!(cell_from_file_rank(file, rank), Some(c));
    }
    // SPEC §1 examples.
    let examples: [(&str, usize, (i32, i32)); 9] = [
        ("a1", 0, (-5, 5)),
        ("a6", 5, (-5, 0)),
        ("b1", 6, (-4, 5)),
        ("f1", 40, (0, 5)),
        ("f6", 45, (0, 0)),
        ("f11", 50, (0, -5)),
        ("g1", 51, (1, 4)),
        ("l1", 85, (5, 0)),
        ("l6", 90, (5, -5)),
    ];
    for (name, idx, qr) in examples {
        assert_eq!(cell(name), idx, "{name}");
        assert_eq!(cell_qr(idx), qr, "{name}");
        assert_eq!(cell_name(idx), name);
    }
    assert_eq!(cell_const("f6"), 45);
    assert_eq!(cell_const("l6"), 90);
    for bad in ["", "a", "a0", "a7", "j1", "f12", "m1", "A1", "f01", "e4x", "b8"] {
        assert_eq!(parse_cell(bad), None, "{bad}");
    }
}

#[test]
fn f6_is_index_45_the_centre() {
    assert_eq!(cell("f6"), 45);
    assert_eq!(CENTER_CELL, 45);
    assert_eq!(CENTER_DIST[45], 0);
    assert_eq!(CENTER_DIST[cell("f1")], 5);
    assert_eq!(CENTER_DIST[cell("a1")], 5);
    assert_eq!(CENTER_DIST[cell("e5")], 1);
    for c in 0..NUM_CELLS {
        assert_eq!(CENTER_DIST[c] as u32, hex_distance(c, 45));
    }
}

#[test]
fn spec_direction_table_examples_from_e4() {
    let e4 = cell("e4");
    let expected = [
        (DIR_N, "e5"),
        (DIR_S, "e3"),
        (DIR_NE, "f5"),
        (DIR_SE, "f4"),
        (DIR_NW, "d4"),
        (DIR_SW, "d3"),
        (DIR_E, "g4"),
        (DIR_W, "c3"),
        (DIR_NNE, "f6"),
        (DIR_NNW, "d5"),
        (DIR_SSE, "f3"),
        (DIR_SSW, "d2"),
    ];
    for (d, name) in expected {
        assert_eq!(NEIGHBOR[d][e4] as usize, cell(name), "direction {}", DIR_NAME[d]);
    }
    for d in 0..NUM_DIRS {
        let o = opposite_dir(d);
        assert_eq!(DIR_DELTA[o], (-DIR_DELTA[d].0, -DIR_DELTA[d].1));
        assert_eq!(is_orthogonal(d), d < 6);
    }
}

#[test]
fn colour_classes_31_30_30_and_bishops_on_three_classes() {
    let mut counts = [0; 3];
    for c in 0..NUM_CELLS {
        counts[CELL_COLOR[c] as usize] += 1;
    }
    assert_eq!(counts, [31, 30, 30]);
    assert_eq!(CELL_COLOR[cell("f6")], 0);
    assert_eq!(CELL_COLOR[cell("f1")], 1);
    assert_eq!(CELL_COLOR[cell("f11")], 2);
    for c in 0..NUM_CELLS {
        for d in 0..NUM_DIRS {
            let n = NEIGHBOR[d][c];
            if n == NO_CELL {
                continue;
            }
            if d < 6 {
                assert_ne!(CELL_COLOR[c], CELL_COLOR[n as usize], "edge neighbours share a colour");
            } else {
                assert_eq!(CELL_COLOR[c], CELL_COLOR[n as usize], "a diagonal step changed colour");
            }
        }
    }
    for v in Variant::ALL {
        let p = Position::start(v);
        for color in [WHITE, BLACK] {
            let mut classes: Vec<u8> = cells(p.pieces(color, BISHOP)).map(|c| CELL_COLOR[c]).collect();
            classes.sort();
            assert_eq!(classes, vec![0, 1, 2], "{v:?} colour {color}");
        }
    }
}

#[test]
fn precomputed_tables_are_consistent() {
    // Centre mobility on an empty board.
    assert_eq!(KNIGHT_ATTACKS[45].count_ones(), 12);
    assert_eq!(KING_ATTACKS[45].count_ones(), 12);
    assert_eq!(rook_attacks(45, 0).count_ones(), 30);
    assert_eq!(bishop_attacks(45, 0).count_ones(), 12);
    assert_eq!(queen_attacks(45, 0).count_ones(), 42);
    for c in 0..NUM_CELLS {
        // Index monotonicity along every ray (the sliding-attack code relies on it).
        for d in 0..NUM_DIRS {
            let mut prev = c;
            let mut x = NEIGHBOR[d][c];
            let mut ray = 0u128;
            while x != NO_CELL {
                if DIR_POSITIVE[d] {
                    assert!(x as usize > prev);
                } else {
                    assert!((x as usize) < prev);
                }
                ray |= bit(x as usize);
                assert_eq!(DIR_BETWEEN[c][x as usize] as usize, d);
                prev = x as usize;
                x = NEIGHBOR[d][prev];
            }
            assert_eq!(RAYS[d][c], ray);
        }
        // Knight jumps are symmetric, never along a line, and match the delta list.
        for t in cells(KNIGHT_ATTACKS[c]) {
            assert!(KNIGHT_ATTACKS[t] & bit(c) != 0);
            assert_eq!(DIR_BETWEEN[c][t], NO_DIR);
            let (q0, r0) = cell_qr(c);
            let (q1, r1) = cell_qr(t);
            assert!(KNIGHT_DELTA.contains(&(q1 - q0, r1 - r0)));
        }
        assert_eq!(ORTHO_LINES[c], rook_attacks(c, 0));
        assert_eq!(DIAG_LINES[c], bishop_attacks(c, 0));
        assert_eq!(KING_ATTACKS[c], {
            let mut k = 0;
            for d in 0..NUM_DIRS {
                if NEIGHBOR[d][c] != NO_CELL {
                    k |= bit(NEIGHBOR[d][c] as usize);
                }
            }
            k
        });
    }
    // Blocked rays and `between`.
    let (e4, f6, g7, h8) = (cell("e4"), cell("f6"), cell("g7"), cell("h8"));
    assert_eq!(between(e4, h8), bit(f6) | bit(g7)); // NNE diagonal e4-f6-g7-h8
    assert_eq!(ray_attacks(DIR_NNE, e4, bit(f6)), bit(f6));
    assert_eq!(ray_attacks(DIR_NNE, e4, bit(h8)), bit(f6) | bit(g7) | bit(h8));
    assert_eq!(between(cell("a1"), cell("f6")), bit(cell("b2")) | bit(cell("c3")) | bit(cell("d4")) | bit(cell("e5")));
    assert_eq!(between(cell("a1"), cell("b2")), 0);
    assert_eq!(between(cell("a1"), cell("c4")), 0);
    assert_eq!(line_through(cell("f1"), cell("f6")).count_ones(), 11);
}
