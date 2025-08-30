// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "../../node_modules/forge-std/src/Script.sol";
import {SymbioticUSDCVaultProxyFactory} from "../../contracts/mainnetUSDC/SymboiticUSDCVaultProxyFactory.sol";

contract CreateUSDCVaultFromFactory is Script {
    function run(
        address factoryAddr,
        address owner,
        address operatorFeeRecipient,
        uint256 unlockTime
    ) external returns (address vault) {
        vm.startBroadcast();
        vault = SymbioticUSDCVaultProxyFactory(factoryAddr).createVault(
            owner, operatorFeeRecipient, uint64(unlockTime)
        );
        vm.stopBroadcast();
    }
}
