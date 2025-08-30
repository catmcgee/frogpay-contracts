import "dotenv/config";
import { createConfig, EVM, getRoutes, executeRoute } from "@lifi/sdk";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  getContract,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20, ERC4626 } from "./abis.js";

const {
  LIFI_API_KEY,
  PRIVATE_KEY,
  LISK_RPC_URL,
  LISK_WSTETH_ADDRESS: WSTETH_ENV,
  MELLOW_WSTETH_VAULT_LISK: VAULT_ENV,
} = process.env as Record<string, string>;

if (!LIFI_API_KEY || !PRIVATE_KEY || !LISK_RPC_URL) {
  throw new Error("Missing env: LIFI_API_KEY, PRIVATE_KEY, LISK_RPC_URL");
}

const lisk = defineChain({
  id: 1135,
  name: "Lisk",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LISK_RPC_URL] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://blockscout.lisk.com" },
  },
});

const WSTETH = (WSTETH_ENV ||
  "0x76D8de471F54aAA87784119c60Df1bbFc852C415") as `0x${string}`;
// Mellow Symboitic wstETH Vault on Lisk
const MELLOW_VAULT = (VAULT_ENV ||
  "0x1b10E2270780858923cdBbC9B5423e29fffD1A44") as `0x${string}`;

createConfig({
  integrator: "monadpay-lisk-script",
  apiKey: LIFI_API_KEY,
  rpcUrls: { [lisk.id]: [LISK_RPC_URL] },
  providers: [
    EVM({
      getWalletClient: async () => liskWallet,
      switchChain: async (chainId) => {
        if (chainId === lisk.id) return liskWallet;
        throw new Error(`Unsupported chain ${chainId}`);
      },
    }),
  ],
});

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const liskWallet = createWalletClient({
  account,
  chain: lisk,
  transport: http(LISK_RPC_URL),
});
const liskPublic = createPublicClient({
  chain: lisk,
  transport: http(LISK_RPC_URL),
});

const SEND_ETH = parseEther("0.001");
const NATIVE = "0x0000000000000000000000000000000000000000"; // LI.FI native sentinel

// swap Lisk ETH -> wstETH
async function swapEthToWstethOnLisk() {
  console.log(
    `Requesting route: ${formatEther(SEND_ETH)} Lisk ETH → wstETH on Lisk for ${
      account.address
    } ...`
  );
  const { routes } = await getRoutes({
    fromChainId: lisk.id,
    toChainId: lisk.id,
    fromTokenAddress: NATIVE,
    toTokenAddress: WSTETH,
    fromAmount: SEND_ETH.toString(),
    fromAddress: account.address,
    toAddress: account.address,
    options: { slippage: 0.005 }, // leave exchanges/bridges unspecified for best coverage on Lisk
  });
  if (!routes?.length)
    throw new Error("No LI.FI routes returned for Lisk ETH → wstETH");

  const route = routes[0];
  console.log(`Executing LI.FI route with ${route.steps.length} step(s)...`);
  await executeRoute(route, {
    updateRouteHook: (updated) => {
      const step = updated.steps.at(-1);
      const status = step?.execution?.status;
      if (status) console.log(`[LI.FI] step=${step?.tool} status=${status}`);
      updated.steps.forEach((s, i) => {
        s.execution?.process.forEach((p) => {
          if (p.txHash) console.log(`  step#${i + 1} ${p.type} tx=${p.txHash}`);
        });
      });
    },
    acceptExchangeRateUpdateHook: async () => true,
  });
}

// deposit
async function depositAllWstethToMellow() {
  const wst = getContract({
    address: WSTETH,
    abi: ERC20,
    client: { wallet: liskWallet, public: liskPublic },
  });
  const vault = getContract({
    address: MELLOW_VAULT,
    abi: ERC4626,
    client: { wallet: liskWallet, public: liskPublic },
  });

  const bal = await wst.read.balanceOf([account.address]);
  if (bal === 0n)
    throw new Error("No wstETH balance to deposit. Did the swap succeed?");

  const allowance = await wst.read.allowance([account.address, MELLOW_VAULT]);
  if (allowance < bal) {
    const approveHash = await wst.write.approve([MELLOW_VAULT, bal]);
    console.log(`Approve wstETH→Mellow tx: ${approveHash}`);
    await liskPublic.waitForTransactionReceipt({ hash: approveHash });
  }

  const depHash = await vault.write.deposit([bal, account.address]);
  console.log(`Mellow deposit tx: ${depHash}`);
  await liskPublic.waitForTransactionReceipt({ hash: depHash });

  console.log("✅ Deposited wstETH into Mellow Lisk vault.");
}

async function main() {
  console.log(`Signer (Lisk): ${account.address}`);
  await swapEthToWstethOnLisk();
  await depositAllWstethToMellow();
  console.log("Swapped → deposited into Mellow (Lisk)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
