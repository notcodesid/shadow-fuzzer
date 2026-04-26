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

    // ─── BUG #1: unchecked accounting (static finding) ────────────────────
    // A correct implementation would use `checked_add(amount).ok_or(...)`.
    // SPL token's own u64 supply invariants make this *practically*
    // unreachable from a single mint (you can't legitimately accumulate
    // more than u64::MAX of a single mint in one account), but the bug
    // shape is still real and gets flagged by Shadow Fuzzer's static
    // pass — for example, the moment the program adds yield-accrual or
    // a multi-mint variant, this overflow becomes exploitable. We keep
    // it planted because the agent's narrative output should report
    // both runtime exploits AND high-confidence code smells. The local
    // exploit suite only verifies the runtime-reachable bug (BUG #2);
    // BUG #1 is asserted by the agent's static analysis.
    let position = &mut ctx.accounts.position;
    position.balance = position.balance + amount;

    let vault = &mut ctx.accounts.vault;
    vault.total_deposits = vault.total_deposits + amount;
    // ──────────────────────────────────────────────────────────────────────

    Ok(())
}
