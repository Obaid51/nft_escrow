#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token::Mint;
use anchor_spl::token::TokenAccount;
use std::mem::size_of;

declare_id!("CDrWxJK6t2cLsCp7RjB6jiEVx2z5v8DUxxo7FfeBi4tW");

#[program]
pub mod nft_escrow {
    use super::*;

    pub fn initialize_escrow(ctx: Context<InitializeEscrow>) -> Result<()> {
        // Get the bump directly from the accounts struct without borrowing escrow_account twice
        let bump = ctx.accounts.escrow_account.bump;
        
        let escrow_account = &mut ctx.accounts.escrow_account;
        escrow_account.authority = ctx.accounts.authority.key();
        escrow_account.owner = ctx.accounts.owner.key();
        escrow_account.bump = bump;
        escrow_account.is_active = true;
        escrow_account.nft_count = 0;
        escrow_account.standard_nfts = Vec::new();
        escrow_account.compressed_nfts = Vec::new();
        
        Ok(())
    }

    pub fn deposit_nfts<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositNFTs<'info>>,
        nft_mints: Vec<Pubkey>,
        is_compressed: Vec<bool>,
    ) -> Result<()> {
        let _owner_ai:  AccountInfo<'info> = ctx.accounts.owner.to_account_info();
        let _token_ai:  AccountInfo<'info> = ctx.accounts.token_program.to_account_info();
        require!(
            nft_mints.len() == is_compressed.len(),
            EscrowError::InvalidInputLength
        );
    
        let escrow_account = &mut ctx.accounts.escrow_account;
        let remaining_accounts = &ctx.remaining_accounts;
    
        let mut standard_nft_index = 0;
        let mut _compressed_nft_index = 0;
    
        // ✅ clone once, avoid lifetime issues
        let owner_account_info = ctx.accounts.owner.to_account_info();
        let token_program_info = ctx.accounts.token_program.to_account_info();
    
        for (i, nft_mint) in nft_mints.iter().enumerate() {
            if !is_compressed[i] {
                // standard nft
                let accounts_start = standard_nft_index * 3;
                if accounts_start + 3 > remaining_accounts.len() {
                    return Err(EscrowError::InsufficientAccounts.into());
                }
    
                let _metadata_account_info = &remaining_accounts[accounts_start];
                let user_nft_account_info = &remaining_accounts[accounts_start + 1];
                let vault_nft_account_info = &remaining_accounts[accounts_start + 2];
    
                let owner_key = ctx.accounts.owner.key();
    
                let user_nft_account_data = TokenAccount::try_deserialize(
                    &mut &user_nft_account_info.data.borrow()[..]
                )?;
                require!(
                    user_nft_account_data.owner == owner_key,
                    EscrowError::NotTokenOwner
                );
    
                token::transfer(
                    CpiContext::new(
                        token_program_info.clone(),
                        token::Transfer {
                            from: user_nft_account_info.clone(),
                            to: vault_nft_account_info.clone(),
                            authority: ctx.accounts.owner.to_account_info(), // this is guaranteed to be Signer
                        },
                    ),
                    1,
                )?;
    
                escrow_account.standard_nfts.push(*nft_mint);
                escrow_account.nft_count += 1;
                standard_nft_index += 1;
            } else {
                // compressed nft (bubblegum etc.)
                escrow_account.compressed_nfts.push(*nft_mint);
                escrow_account.nft_count += 1;
                _compressed_nft_index += 1;
            }
        }
    
        Ok(())
    }

    pub fn withdraw_nft(
        ctx: Context<WithdrawNFT>,
        nft_mint: Pubkey,
        is_compressed: bool,
        _recipient: Pubkey, // Prefix with underscore to avoid unused variable warning
    ) -> Result<()> {
        let escrow_account = &mut ctx.accounts.escrow_account;
        
        // Verify authority
        require!(
            ctx.accounts.authority.key() == escrow_account.authority,
            EscrowError::InvalidAuthority
        );
        
        if !is_compressed {
            // Standard NFT withdrawal
            // Find the NFT in the escrow account
            let nft_index = escrow_account.standard_nfts
                .iter()
                .position(|&mint| mint == nft_mint)
                .ok_or(EscrowError::NFTNotFound)?;
            
            // Get account infos before the CPI call to avoid lifetime issues
            let token_program_info = ctx.accounts.token_program.to_account_info();
            let vault_nft_account_info = ctx.accounts.vault_nft_account.to_account_info();
            let recipient_nft_account_info = ctx.accounts.recipient_nft_account.to_account_info();
            let escrow_vault_info = ctx.accounts.escrow_vault.to_account_info();
            
            // Perform token transfer directly without helper function
            token::transfer(
                CpiContext::new_with_signer(
                    token_program_info,
                    token::Transfer {
                        from: vault_nft_account_info,
                        to: recipient_nft_account_info,
                        authority: escrow_vault_info,
                    },
                    &[&[
                        b"escrow_vault".as_ref(),
                        escrow_account.key().as_ref(),
                        &[escrow_account.bump],
                    ]],
                ),
                1,
            )?;
            
            // Remove from escrow account
            escrow_account.standard_nfts.remove(nft_index);
            escrow_account.nft_count -= 1;
        } else {
            // Compressed NFT withdrawal
            // Find the NFT in the escrow account
            let nft_index = escrow_account.compressed_nfts
                .iter()
                .position(|&mint| mint == nft_mint)
                .ok_or(EscrowError::NFTNotFound)?;
            
            // Note: This is a placeholder for the actual cNFT handling
            // In a real implementation, this would use the Bubblegum program
            
            // Remove from escrow account
            escrow_account.compressed_nfts.remove(nft_index);
            escrow_account.nft_count -= 1;
        }
        
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeEscrow<
    'info
> {
    #[account(
        init,
        payer = owner,
        space = 8 + size_of::<EscrowAccount>() + 32 * 100, // Space for up to 100 NFTs initially
        seeds = [b"escrow_account".as_ref(), owner.key().as_ref()],
        bump
    )]
    pub escrow_account: Account<
        'info,
        EscrowAccount
    >,
    
    /// CHECK: This is the authority that can withdraw NFTs
    pub authority: AccountInfo<
        'info
    >,
    
    #[account(mut)]
    pub owner: Signer<
        'info
    >,
    
    pub system_program: Program<
        'info,
        System
    >,
}

#[derive(Accounts)]
pub struct DepositNFTs<
    'info
> {
    #[account(
        mut,
        seeds = [b"escrow_account".as_ref(), owner.key().as_ref()],
        bump = escrow_account.bump,
        has_one = owner @ EscrowError::InvalidOwner,
    )]
    pub escrow_account: Account<
        'info,
        EscrowAccount
    >,
    
    #[account(mut)]
    pub owner: Signer<
        'info
    >,
    
    pub token_program: Program<
        'info,
        Token
    >,
    pub associated_token_program: Program<
        'info,
        AssociatedToken
    >,
    pub system_program: Program<
        'info,
        System
    >,
    pub rent: Sysvar<
        'info,
        Rent
    >,
}

#[derive(Accounts)]
pub struct WithdrawNFT<
    'info
> {
    #[account(
        mut,
        seeds = [b"escrow_account".as_ref(), escrow_account.owner.as_ref()],
        bump = escrow_account.bump,
    )]
    pub escrow_account: Account<
        'info,
        EscrowAccount
    >,
    
    #[account(mut)]
    pub authority: Signer<
        'info
    >,
    
    /// CHECK: This is the PDA that owns the vault NFT accounts
    #[account(
        seeds = [b"escrow_vault".as_ref(), escrow_account.key().as_ref()],
        bump,
    )]
    pub escrow_vault: AccountInfo<
        'info
    >,
    
    pub mint: Account<
        'info,
        Mint
    >,
    
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow_vault,
    )]
    pub vault_nft_account: Account<
        'info,
        TokenAccount
    >,
    
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_nft_account: Account<
        'info,
        TokenAccount
    >,
    
    /// CHECK: This is the recipient of the NFT
    pub recipient: AccountInfo<
        'info
    >,
    
    pub token_program: Program<
        'info,
        Token
    >,
    pub associated_token_program: Program<
        'info,
        AssociatedToken
    >,
    pub system_program: Program<
        'info,
        System
    >,
    pub rent: Sysvar<
        'info,
        Rent
    >,
}

#[account]
pub struct EscrowAccount {
    pub authority: Pubkey,        // The authority that can withdraw NFTs
    pub owner: Pubkey,            // Original owner of the NFTs
    pub bump: u8,                 // PDA bump
    pub is_active: bool,          // Whether the escrow is active
    pub nft_count: u32,           // Number of NFTs in escrow
    pub standard_nfts: Vec<Pubkey>, // List of standard NFT mint addresses
    pub compressed_nfts: Vec<Pubkey>, // List of compressed NFT addresses
}

#[error_code]
pub enum EscrowError {
    #[msg("Invalid authority")]
    InvalidAuthority,
    
    #[msg("Invalid owner")]
    InvalidOwner,
    
    #[msg("NFT not found in escrow")]
    NFTNotFound,
    
    #[msg("Not the token owner")]
    NotTokenOwner,
    
    #[msg("Invalid input length")]
    InvalidInputLength,
    
    #[msg("Insufficient accounts provided")]
    InsufficientAccounts,
}
