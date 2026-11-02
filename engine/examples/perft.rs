//! Perft benchmark: `cargo run --release --example perft [max_depth_glinski] [max_depth_mccooey]`
//!
//! Prints node counts and speed (bulk-counted and full make/unmake of every leaf).

use hexchess_engine::{clock_ms, Position, Variant};

fn run(variant: Variant, max_depth: u32) {
    println!("== {} ==", variant.name());
    for depth in 1..=max_depth {
        let mut pos = Position::start(variant);
        let t0 = clock_ms();
        let n = pos.perft(depth);
        let ms = clock_ms() - t0;
        let rate = n as f64 / (ms.max(0.001) / 1000.0) / 1e6;
        println!("perft({depth}) = {n:>14}   {ms:>9.1} ms   {rate:>7.1} M nodes/s (bulk)");
    }
    // Same deepest depth that is cheap enough without bulk counting.
    let depth = max_depth.min(5).saturating_sub(1).max(1);
    let mut pos = Position::start(variant);
    let t0 = clock_ms();
    let n = pos.perft_full(depth);
    let ms = clock_ms() - t0;
    let rate = n as f64 / (ms.max(0.001) / 1000.0) / 1e6;
    println!("perft_full({depth}) = {n:>10}   {ms:>9.1} ms   {rate:>7.1} M nodes/s (make/unmake every leaf)");
}

fn main() {
    let args: Vec<u32> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    run(Variant::Glinski, args.first().copied().unwrap_or(4));
    run(Variant::McCooey, args.get(1).copied().unwrap_or(5));
}
