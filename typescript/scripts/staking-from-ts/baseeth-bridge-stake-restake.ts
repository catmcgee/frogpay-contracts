import "dotenv/config";
import { createConfig, EVM, getRoutes, executeRoute } from "@lifi/sdk";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  parseEther,
  formatEther,
  getContract,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { ERC20, LIDO, WSTETH_ABI, SYMBIOTIC_VAULT } from "./abis.js";

const { LIFI_API_KEY, PRIVATE_KEY, ETH_RPC_URL, BASE_RPC_URL } =
  process.env as Record<string, string>;
if (!LIFI_API_KEY || !PRIVATE_KEY || !ETH_RPC_URL || !BASE_RPC_URL) {
  throw new Error(
    "Missing env: LIFI_API_KEY, PRIVATE_KEY, ETH_RPC_URL, BASE_RPC_URL"
  );
}

const CHAIN_BASE = 8453;
const CHAIN_ETH = 1;
const SEND_ETH = parseEther("0.001");

const NATIVE = "0x0000000000000000000000000000000000000000";

// Lido mainnet
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as const;
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0" as const;

// Symbiotic Gauntlet Restaked wstETH
const SYMBIOTIC_WSTETH_VAULT =
  "0xc10A7f0AC6E3944F4860eE97a937C51572e3a1Da" as const;

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const ethWallet = createWalletClient({
  account,
  chain: mainnet,
  transport: http(ETH_RPC_URL),
});
const ethPublic = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC_URL),
});
const baseWallet = createWalletClient({
  account,
  chain: base,
  transport: http(BASE_RPC_URL),
});

createConfig({
  integrator: "monadpay-scripts",
  apiKey: LIFI_API_KEY,
  rpcUrls: {
    [CHAIN_ETH]: [ETH_RPC_URL],
    [CHAIN_BASE]: [BASE_RPC_URL],
  },
  providers: [
    EVM({
      getWalletClient: async () => ethWallet,
      switchChain: async (chainId) => {
        if (chainId === CHAIN_ETH) return ethWallet;
        if (chainId === CHAIN_BASE) return baseWallet;
        throw new Error(`Unsupported chain ${chainId}`);
      },
    }),
  ],
});

// bridge base eth to l1
async function bridgeBaseEthToMainnetEth() {
  console.log(
    `Requesting route: 0.001 ETH Base → ETH Mainnet for ${account.address} ...`
  );
  const { routes } = await getRoutes({
    fromChainId: CHAIN_BASE,
    toChainId: CHAIN_ETH,
    fromTokenAddress: NATIVE,
    toTokenAddress: NATIVE,
    fromAmount: SEND_ETH.toString(),
    fromAddress: account.address,
    toAddress: account.address,
    options: {
      slippage: 0.005,
      bridges: { allow: ["across", "stargate", "hop"] },
      exchanges: { prefer: ["1inch", "uniswap"] },
    },
  });
  if (!routes?.length) throw new Error("No LI.FI routes returned");

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

// stake via lido
async function stakeAndWrapAllButBuffer() {
  const GAS_BUFFER = parseEther("0.0003");
  const bal = await ethPublic.getBalance({ address: account.address });
  if (bal <= GAS_BUFFER)
    throw new Error(
      `Not enough L1 ETH to stake (balance ${formatEther(bal)} ETH)`
    );

  const stakeValue = bal - GAS_BUFFER;
  console.log(`Staking ${formatEther(stakeValue)} ETH → stETH...`);

  const data = encodeFunctionData({
    abi: LIDO,
    functionName: "submit",
    args: ["0x0000000000000000000000000000000000000000"],
  });
  const txHash = await ethWallet.sendTransaction({
    account,
    to: STETH,
    data,
    value: stakeValue,
  });
  console.log(`Lido submit tx: ${txHash}`);
  await ethPublic.waitForTransactionReceipt({ hash: txHash });

  // check stETH balance
  const steth = getContract({
    address: STETH,
    abi: ERC20,
    client: { wallet: ethWallet, public: ethPublic },
  });
  const stBal = await steth.read.balanceOf([account.address]);

  // approve wstETH to pull stETH
  const allowance = await steth.read.allowance([account.address, WSTETH]);
  if (allowance < stBal) {
    const approveHash = await steth.write.approve([WSTETH, stBal]);
    console.log(`Approve stETH->wstETH tx: ${approveHash}`);
    await ethPublic.waitForTransactionReceipt({ hash: approveHash });
  }

  // wrap to wstETH
  const wst = getContract({
    address: WSTETH,
    abi: WSTETH_ABI,
    client: { wallet: ethWallet, public: ethPublic },
  });
  const wrapHash = await wst.write.wrap([stBal]);
  console.log(`Wrap stETH->wstETH tx: ${wrapHash}`);
  await ethPublic.waitForTransactionReceipt({ hash: wrapHash });

  // final wstETH balance
  const wstErc = getContract({
    address: WSTETH,
    abi: ERC20,
    client: { wallet: ethWallet, public: ethPublic },
  });
  const wstBal = await wstErc.read.balanceOf([account.address]);
  console.log(`wstETH balance: ${wstBal} wei`);
  return wstBal;
}

// deposit to symbiotic vault
async function depositToSymbiotic(wstAmount: bigint) {
  const vault = getContract({
    address: SYMBIOTIC_WSTETH_VAULT,
    abi: SYMBIOTIC_VAULT,
    client: { wallet: ethWallet, public: ethPublic },
  });

  const col = await vault.read.collateral();
  if (col.toLowerCase() !== WSTETH.toLowerCase())
    throw new Error(
      `Vault collateral mismatch: expected ${WSTETH}, got ${col}`
    );

  const wst = getContract({
    address: WSTETH,
    abi: ERC20,
    client: { wallet: ethWallet, public: ethPublic },
  });
  const allowance = await wst.read.allowance([
    account.address,
    SYMBIOTIC_WSTETH_VAULT,
  ]);
  if (allowance < wstAmount) {
    const approveHash = await wst.write.approve([
      SYMBIOTIC_WSTETH_VAULT,
      wstAmount,
    ]);
    console.log(`Approve wstETH→Vault tx: ${approveHash}`);
    await ethPublic.waitForTransactionReceipt({ hash: approveHash });
  }

  const depHash = await vault.write.deposit([account.address, wstAmount]);
  console.log(`Symbiotic deposit tx: ${depHash}`);
  await ethPublic.waitForTransactionReceipt({ hash: depHash });
}

async function main() {
  console.log(`Signer: ${account.address}`);
  await bridgeBaseEthToMainnetEth();
  const wstBal = await stakeAndWrapAllButBuffer();
  await depositToSymbiotic(wstBal);
  console.log("Done!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
