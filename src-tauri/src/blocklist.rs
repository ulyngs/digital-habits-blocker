//! Blocklist helpers (thin re-export of `redd_block_core::blocklist`).
//!
//! The derivation logic moved into the shared `redd-block-core` crate so
//! the privileged helper daemon can reuse it. Every callsite inside the
//! Tauri app still uses `crate::blocklist::…`, so this module just
//! re-exports the public surface.

pub use redd_block_core::blocklist::*;
