use anchor_lang::prelude::*;

use crate::state::{UserPosition, Vault, POSITION_SEED};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = owner,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, UserPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenPosition>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.owner.key();
    position.vault = ctx.accounts.vault.key();
    position.balance = 0;
    position.bump = ctx.bumps.position;
    Ok(())
}
