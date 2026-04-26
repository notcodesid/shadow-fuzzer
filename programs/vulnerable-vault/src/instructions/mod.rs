pub mod delegate_vault;
pub mod deposit;
pub mod initialize_vault;
pub mod open_position;
pub mod undelegate_for_fuzz;
pub mod withdraw;

// Glob re-exports are required: anchor's `#[program]` macro on lib.rs
// reaches into each instruction module's auto-generated `__client_
// accounts_*` and `__cpi_client_accounts_*` modules, and they can only
// resolve via `crate::*` if mod.rs globs them up. The harmless side
// effect is an ambiguous-glob warning on the per-module `handler`
// functions — we never use them via the glob (lib.rs calls each
// handler via its full `instructions::deposit::handler` path).
#[allow(ambiguous_glob_reexports)]
pub use delegate_vault::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize_vault::*;
#[allow(ambiguous_glob_reexports)]
pub use open_position::*;
#[allow(ambiguous_glob_reexports)]
pub use undelegate_for_fuzz::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw::*;
