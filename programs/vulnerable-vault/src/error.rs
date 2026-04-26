use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Insufficient balance in user position")]
    InsufficientBalance,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
