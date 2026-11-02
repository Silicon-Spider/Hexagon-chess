//! Search benchmark: `cargo run --release --example bench [time_ms ...]`
//!
//! For both variants, searches the start position (and a middlegame position) with each time
//! limit (default 1000 and 3000 ms) and prints the depth reached, score, nodes, speed and PV.
//! Then runs fixed-depth searches (deterministic node counts) as a regression reference.

use hexchess_engine::search::{search, SearchLimits, SearchResult};
use hexchess_engine::{Game, Variant};

fn pv_san(game: &Game, r: &SearchResult) -> String {
    let mut g = game.clone();
    let mut out = Vec::new();
    for &m in &r.info.pv {
        match g.san(m) {
            Some(s) => {
                out.push(s);
                if !g.make_move(m) {
                    out.push("<illegal>".into());
                    break;
                }
            }
            None => {
                out.push(format!("<illegal {m}>"));
                break;
            }
        }
    }
    out.join(" ")
}

fn report(label: &str, game: &Game, limits: SearchLimits) {
    let r = search(game, &limits);
    let i = &r.info;
    let nps = i.nodes as f64 / (i.elapsed_ms.max(1) as f64 / 1000.0);
    println!(
        "{label:<34} depth {:>2}  score {:>6}  nodes {:>10}  {:>6} ms  {:>7.0} knps  pv {}",
        i.depth,
        i.score,
        i.nodes,
        i.elapsed_ms,
        nps / 1000.0,
        pv_san(game, &r)
    );
}

/// The position after 12 plies of depth-4 self-play (deterministic).
fn middlegame(variant: Variant) -> Game {
    let mut g = Game::new(variant);
    for _ in 0..12 {
        let r = search(&g, &SearchLimits { max_depth: 4, time_ms: 0, noise_cp: 0, seed: 0 });
        assert!(g.make_move(r.best), "self-play produced an illegal move");
    }
    g
}

fn main() {
    let mut times: Vec<u32> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    if times.is_empty() {
        times = vec![1000, 3000];
    }
    for v in Variant::ALL {
        let start = Game::new(v);
        let mid = middlegame(v);
        for &t in &times {
            let lim = SearchLimits { max_depth: 0, time_ms: t, noise_cp: 0, seed: 0 };
            report(&format!("{} start, {t} ms", v.name()), &start, lim);
            report(&format!("{} middlegame, {t} ms", v.name()), &mid, lim);
        }
    }
    println!();
    for v in Variant::ALL {
        for depth in [4, 6, 8] {
            let lim = SearchLimits { max_depth: depth, time_ms: 0, noise_cp: 0, seed: 0 };
            report(&format!("{} start, depth {depth}", v.name()), &Game::new(v), lim);
        }
    }
}
