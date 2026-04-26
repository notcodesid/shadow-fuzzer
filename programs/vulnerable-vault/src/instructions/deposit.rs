use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::VaultError;
use crate::state::{UserPosition, Vault, POSITION_SEED};

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
    )]
    pub position: Account<'info, UserPosition>,

    #[account(mut, address = vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut, token::mint = vault.mint, token::authority = owner)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);

    let cpi_accounts = Transfer {
        from: ctx.accounts.user_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
        amount,
    )?;

    // ─── BUG #1: unchecked accounting ─────────────────────────────────────
    // A correct implementation would use `checked_add(amount).ok_or(...)`.
    // With raw `+`, a large deposit (or several smaller ones) overflows u64
    // and the running totals silently wrap. Subsequent withdraws then drain
    // the vault while INV-1 (Σ balances == total_deposits) still holds on
    // the wrapped values.
    let position = &mut ctx.accounts.position;
    position.balance = position.balance + amount;

    let vault = &mut ctx.accounts.vault;
    vault.total_deposits = vault.total_deposits + amount;
    // ──────────────────────────────────────────────────────────────────────

    Ok(())
}
