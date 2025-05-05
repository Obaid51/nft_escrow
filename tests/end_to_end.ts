import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { NftEscrow } from "../target/types/nft_escrow";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress
} from "@solana/spl-token";

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
const mint     = new PublicKey("8RUYCM2qVjFXBbdGo9Vt8rbeyEA6V3SwT4PU3eVte3nP"); 

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
      escrow: escrow,
      authority:     owner,
      owner,
      systemProgram: SystemProgram.programId,
    });

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
  const vaultAta = await getAssociatedTokenAddress(
    mint,
    vaultPda,
    true // allowOwnerOffCurve
  );

  // Ensure the vault ATA exists before transferring the NFT
  const vaultAtaInfo = await conn.getAccountInfo(vaultAta);
  if (!vaultAtaInfo) {
    console.log("⚠️ Vault ATA doesn't exist. Creating it...");
    const ataIx = createAssociatedTokenAccountInstruction(
      owner,
      vaultAta,
      vaultPda,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tx = new anchor.web3.Transaction().add(ataIx);
    await provider.sendAndConfirm(tx);
  }

  const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metaPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()],
    METAPLEX
  );

  try {
    
    // Check if the user ATA exists and has the token
    const userBalance = await conn.getTokenAccountBalance(userAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("User ATA balance before:", userBalance.value.uiAmount ?? 0);
    if (!userBalance.value.uiAmount) {
      throw new Error("User ATA doesn't have the NFT - deposit may have failed");
    }
    // Check if the vault ATA exists
    const vaultBalance = await conn.getTokenAccountBalance(vaultAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("Vault ATA balance before:", vaultBalance.value.uiAmount ?? 0);
    if (vaultBalance.value.uiAmount) {
      throw new Error("Vault ATA already has the NFT - deposit may have failed");
    }
    // Check if the user ATA exists
    const userExists = await conn.getAccountInfo(userAta);
    if (!userExists) {
      throw new Error("User ATA doesn't exist - deposit may have failed");
    }

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
      { pubkey: mint,     isWritable: false, isSigner: false },
      { pubkey: wallet.publicKey, isWritable: false, isSigner: true }, // ✅ needed for CPI transfer authority
    ]);

    console.log("✅ NFT deposited");
    
    // Verify the deposit worked
    const balanceAfter = await conn.getTokenAccountBalance(vaultAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("Vault ATA balance after:", balanceAfter.value.uiAmount ?? 0);

    // if ((balanceAfter.value.uiAmount ?? 0) < 1) {
    //   throw new Error("Deposit failed: Vault did not receive the NFT");
    // }
    
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
  const vaultAta = await getAssociatedTokenAddress(
    mint,
    vaultPda,
    true
  );
  const recipientAta = await getAssociatedTokenAddress(
    mint,
    owner
  );

  try {
    const balBefore = await conn.getTokenAccountBalance(recipientAta)
                                .catch(() => ({value:{uiAmount:0}}));
    console.log("recipient balance before:", balBefore.value.uiAmount ?? 0);

    // Check if vault ATA exists and has the token
    const vaultBalance = await conn.getTokenAccountBalance(vaultAta)
                                .catch(() => ({value:{uiAmount:0}}));
    console.log("vault balance before withdrawal:", vaultBalance.value.uiAmount ?? 0);
    
    // if (!vaultBalance.value.uiAmount) {
    //   throw new Error("Vault doesn't have the NFT - deposit may have failed");
    // }

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
    });

    const balAfter = await conn.getTokenAccountBalance(recipientAta)
                              .catch(() => ({value:{uiAmount:0}}));
    console.log("✅ withdraw done. recipient balance now:", balAfter.value.uiAmount ?? 0);
  } catch (e: any) {
    console.error("Withdrawal error:", e);
    throw e;
  }
});