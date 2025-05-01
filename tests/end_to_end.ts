import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { NftEscrow } from "../target/types/nft_escrow";

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */
const KC = path.resolve(__dirname, "../temp.json");
const secret  = JSON.parse(fs.readFileSync(KC, "utf8"));
const kp      = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
const wallet  = new anchor.Wallet(kp);

const conn     = new anchor.web3.Connection("https://api.devnet.solana.com","confirmed");
const provider = new anchor.AnchorProvider(conn, wallet,{commitment:"confirmed"});
anchor.setProvider(provider);

const program  = anchor.workspace.NftEscrow as anchor.Program<NftEscrow>;
const mint     = new PublicKey("HjPQ2exbahHyYTQ8yFAfzWBzcJrbGUSR5K2ygvMfp2FX"); // your NFT

function ata(m: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

/* ------------------------------------------------------------------------- */
/* 1. initialise escrow (runs once, ignores if already exists)               */
/* ------------------------------------------------------------------------- */
it("initialises escrow", async () => {
  const owner = wallet.publicKey;
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_account"), owner.toBuffer()],
    program.programId
  );

  try {
    await program.methods.initializeEscrow().accounts({
      escrowAccount: escrow,
      authority:     owner,
      owner,
      systemProgram: SystemProgram.programId,
    }).rpc();

    console.log("✅ fresh escrow:", escrow.toBase58());
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("ℹ️ escrow already exists:", escrow.toBase58());
    } else { throw e; }
  }
});

/* ------------------------------------------------------------------------- */
/* 2. deposit the NFT                                                        */
/* ------------------------------------------------------------------------- */
it("deposits NFT", async () => {
  const owner  = wallet.publicKey;
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_account"), owner.toBuffer()],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_vault"), escrow.toBuffer()],
    program.programId
  );

  const userAta  = ata(mint, owner);
  const vaultAta = ata(mint, vaultPda);

  const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metaPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()],
    METAPLEX
  );

  try {
    const balanceBefore = await conn.getTokenAccountBalance(userAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("User ATA balance before:", balanceBefore.value.uiAmount ?? 0);
    
    // Add the vault PDA to the accounts explicitly
    await program.methods.depositNfts([mint], [false]).accounts({
      escrowAccount: escrow,
      owner,
      escrowVault: vaultPda, 
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).remainingAccounts([
      { pubkey: metaPda,  isWritable: false, isSigner: false },
      { pubkey: userAta,  isWritable: true,  isSigner: false },
      { pubkey: vaultAta, isWritable: true,  isSigner: false },
      { pubkey: mint,     isWritable: false, isSigner: false },  // Add mint directly
    ]).rpc();

    console.log("✅ NFT deposited");
    
    // Verify the deposit worked
    const balanceAfter = await conn.getTokenAccountBalance(vaultAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("Vault ATA balance after:", balanceAfter.value.uiAmount ?? 0);
    
  } catch (e: any) {
    console.error("Deposit error:", e);
    // If we get a specific error about the ATA not existing, try creating it first
    if (e.message?.includes("AccountNotInitialized") || 
        e.message?.includes("invalid account data")) {
      console.log("⚠️ The vault ATA might not exist yet. Consider creating it first.");
    }
    throw e;
  }
});

/* ------------------------------------------------------------------------- */
/* 3. withdraw it back                                                       */
/* ------------------------------------------------------------------------- */
it("withdraws NFT", async () => {
  const owner   = wallet.publicKey;
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_account"), owner.toBuffer()],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_vault"), escrow.toBuffer()],
    program.programId
  );
  const vaultAta      = ata(mint, vaultPda);
  const recipientAta  = ata(mint, owner);

  try {
    const balBefore = await conn.getTokenAccountBalance(recipientAta)
                                .catch(() => ({value:{uiAmount:0}}));
    console.log("recipient balance before:", balBefore.value.uiAmount ?? 0);

    // Check if vault ATA exists and has the token
    const vaultBalance = await conn.getTokenAccountBalance(vaultAta)
                                .catch(() => ({value:{uiAmount:0}}));
    console.log("vault balance before withdrawal:", vaultBalance.value.uiAmount ?? 0);
    
    if (!vaultBalance.value.uiAmount) {
      throw new Error("Vault doesn't have the NFT - deposit may have failed");
    }

    await program.methods.withdrawNft(mint, false, owner).accounts({
      escrowAccount: escrow,
      authority:     owner,
      escrowVault:   vaultPda,
      mint,
      vaultNftAccount:     vaultAta,
      recipientNftAccount: recipientAta,
      recipient:           owner,
      tokenProgram:        TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram:       SystemProgram.programId,
      rent:                anchor.web3.SYSVAR_RENT_PUBKEY,
    }).rpc();

    const balAfter = await conn.getTokenAccountBalance(recipientAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("✅ withdraw done. recipient balance now:", balAfter.value.uiAmount ?? 0);
  } catch (e: any) {
    console.error("Withdrawal error:", e);
    throw e;
  }
});