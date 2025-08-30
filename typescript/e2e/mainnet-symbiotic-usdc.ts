// file: e2e/usdc-susde-rsusde.ts
import "dotenv/config";
import {
  Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  getContract,
  http,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import VaultArtifact from "../assets/SymbioticUSDCVault.json";

const {
  PRIVATE_KEY,
  ETH_RPC_URL,
  LIFI_API_KEY,
  VAULT_ADDRESS, // deployed SymbioticUSDCVault
  USDC_ADDRESS = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  SUSDE_ADDRESS = "0x9d39A5DE30e57443BfF2A8307A4256c8797A3497",
  RSUSDE_4626_ADDRESS, // your rsUSDe ERC-4626 (Mellow) address
  AMOUNT_USDC = "1", // 1 USDC
  WITHDRAW_FRACTION_BPS = "5000", // withdraw 50% of shares
  AUTO_ALLOW_ROUTER = "true",
} = process.env as Record<string, string>;

if (
  !PRIVATE_KEY ||
  !ETH_RPC_URL ||
  !LIFI_API_KEY ||
  !VAULT_ADDRESS ||
  !RSUSDE_4626_ADDRESS
) {
  throw new Error(
    "Missing env (need PRIVATE_KEY, ETH_RPC_URL, LIFI_API_KEY, VAULT_ADDRESS, RSUSDE_4626_ADDRESS)"
  );
}

const eth = defineChain({
  id: 1,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETH_RPC_URL!] } },
});
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const pub = createPublicClient({ chain: eth, transport: http(ETH_RPC_URL) });
const wallet = createWalletClient({
  account,
  chain: eth,
  transport: http(ETH_RPC_URL),
});

const VAULT = getAddress(VAULT_ADDRESS as Address);
const USDC = getAddress(USDC_ADDRESS as Address);
const SUSDE = getAddress(SUSDE_ADDRESS as Address);
const RS = getAddress(RSUSDE_4626_ADDRESS as Address);

const vault = getContract({
  address: VAULT,
  abi: (VaultArtifact as any).abi,
  client: { public: pub, wallet },
});

const ERC20_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC4626_ABI = [
  {
    type: "function",
    name: "previewDeposit",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "previewRedeem",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const usdc = getContract({
  address: USDC,
  abi: ERC20_ABI,
  client: { public: pub, wallet },
});
const susde = getContract({
  address: SUSDE,
  abi: ERC20_ABI,
  client: { public: pub },
});
const rs = getContract({
  address: RS,
  abi: ERC4626_ABI,
  client: { public: pub },
});

async function getLifiQuote(params: {
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  fromAddress: Address;
  toAddress: Address;
  slippageBps?: number;
}) {
  const url = new URL("https://li.quest/v1/quote");
  url.searchParams.set("fromChain", "1");
  url.searchParams.set("toChain", "1");
  url.searchParams.set("fromToken", params.fromToken);
  url.searchParams.set("toToken", params.toToken);
  url.searchParams.set("fromAmount", params.fromAmount.toString());
  url.searchParams.set("fromAddress", params.fromAddress);
  url.searchParams.set("toAddress", params.toAddress);
  url.searchParams.set("slippage", String((params.slippageBps ?? 50) / 10000)); // 0.5%
  const res = await fetch(url.toString(), {
    headers: { "x-lifi-api-key": LIFI_API_KEY!, accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(`LI.FI quote failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const tr = data?.transactionRequest;
  const minOut = data?.estimate?.toAmountMin;
  if (!tr?.to || !tr?.data || minOut == null)
    throw new Error("Bad LI.FI response");
  return {
    router: getAddress(tr.to),
    data: tr.data as `0x${string}`,
    minOut: BigInt(minOut),
    tool: data?.tool as string | undefined,
  };
}

async function ensureRouterAllowed(router: Address) {
  const allowed = await (vault.read.isRouterAllowed as any)([router]);
  if (allowed) return true;
  if (AUTO_ALLOW_ROUTER !== "true") return false;
  const tx = await (vault.write.setRouterAllowed as any)([router, true]);
  console.log(`setRouterAllowed tx: ${tx}`);
  await pub.waitForTransactionReceipt({ hash: tx });
  return true;
}

async function main() {
  console.log(`Signer: ${account.address}`);
  console.log(`Vault : ${VAULT}`);
  const usdcDec = Number(await usdc.read.decimals());
  const amount = parseUnits(AMOUNT_USDC, usdcDec);

  // Approve vault to pull USDC
  const cur = await usdc.read.allowance([account.address, VAULT]);
  if (cur < amount) {
    const tx = await usdc.write.approve([VAULT, amount]);
    console.log(`approve USDC→vault: ${tx}`);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // Quote USDC -> sUSDe to the vault
  console.log(`[1] Quoting USDC→sUSDe for ${AMOUNT_USDC} USDC...`);
  const qDep = await getLifiQuote({
    fromToken: USDC,
    toToken: SUSDE,
    fromAmount: amount,
    fromAddress: VAULT,
    toAddress: VAULT,
  });
  console.log(
    `Router=${qDep.router} Tool=${qDep.tool} minOut(sUSDe)=${qDep.minOut}`
  );

  await ensureRouterAllowed(qDep.router);

  // Estimate min shares
  const estShares = await rs.read.previewDeposit([qDep.minOut]);
  console.log(`previewDeposit(min sUSDe): ${estShares} shares`);

  // Deposit
  console.log(`[1] depositUSDCViaRouter...`);
  const depTx = await (vault.write.depositUSDCViaRouter as any)([
    amount,
    qDep.router,
    qDep.data,
    qDep.minOut,
    estShares,
  ]);
  console.log(`deposit tx: ${depTx}`);
  await pub.waitForTransactionReceipt({ hash: depTx });

  // Check position
  const shares = await (vault.read.userShares as any)([account.address]);
  const assets = await (vault.read.currentAssetsOf as any)([account.address]);
  console.log(
    `[1] Position: shares=${shares} ~ assets≈ ${formatUnits(assets, 18)} sUSDe`
  );

  // Withdraw fraction
  const bps = Number(WITHDRAW_FRACTION_BPS);
  const sharesToRedeem =
    bps >= 10000 ? shares : (shares * BigInt(bps)) / 10000n;
  if (sharesToRedeem === 0n) throw new Error("No shares to redeem");

  const expectSUSDe = await rs.read.previewRedeem([sharesToRedeem]);
  console.log(
    `[2] Quoting sUSDe→USDC for redeem ~${formatUnits(
      expectSUSDe,
      18
    )} sUSDe...`
  );
  const qWd = await getLifiQuote({
    fromToken: SUSDE,
    toToken: USDC,
    fromAmount: expectSUSDe,
    fromAddress: VAULT,
    toAddress: VAULT,
  });
  console.log(
    `Router=${qWd.router} Tool=${qWd.tool} minOut(USDC)=${qWd.minOut}`
  );

  await ensureRouterAllowed(qWd.router);

  console.log(`[2] withdrawSplitToUSDC...`);
  const wdTx = await (vault.write.withdrawSplitToUSDC as any)([
    sharesToRedeem,
    qWd.router,
    qWd.data,
    qWd.minOut,
  ]);
  console.log(`withdraw tx: ${wdTx}`);
  await pub.waitForTransactionReceipt({ hash: wdTx });

  const balUsdc = await usdc.read.balanceOf([account.address]);
  console.log(`[3] Signer USDC balance: ${formatUnits(balUsdc, usdcDec)} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
