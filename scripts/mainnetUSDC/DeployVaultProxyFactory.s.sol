// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "../../node_modules/forge-std/src/Script.sol";
import {SymbioticUSDCVaultProxyFactory} from "../../contracts/mainnetUSDC/SymboiticUSDCVaultProxyFactory.sol";

contract DeployUSDCOperatorOwnerOnlyVaultFactory is Script {
    function run(address usdc, address susde, address rsVault) external returns (address factory) {
        vm.startBroadcast();
        factory = address(new SymbioticUSDCVaultProxyFactory(usdc, susde, rsVault));
        vm.stopBroadcast();
    }
}
