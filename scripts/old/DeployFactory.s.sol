// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "../../node_modules/forge-std/src/Script.sol";
import {VaultFactory} from "../../contracts/old/VaultFactory.sol";

contract DeployFactoryScript is Script {
    function run() external returns (VaultFactory factory) {
        vm.startBroadcast();
        factory = new VaultFactory();
        vm.stopBroadcast();
    }
}
