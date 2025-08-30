// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SymbioticUSDCVaultProxy.sol";

contract VaultFactory {
  event VaultCreated(address indexed owner, address vault, address wsteth, address mellowVault, address weth, address feeRecipient, uint64 unlockTime);

  address[] public allVaults;
  mapping(address => address[]) public vaultsByOwner;

  function createVault(
    address owner_,
    address wsteth,
    address mellowVault,
    address weth,
    address feeRecipient,
    uint64  unlockTime
  ) external returns (address vault) {
    vault = address(new SymbioticLiskETHOwnerOnlyVault(
      owner_, wsteth, mellowVault, weth, feeRecipient, unlockTime
    ));
    allVaults.push(vault);
    vaultsByOwner[owner_].push(vault);
    emit VaultCreated(owner_, vault, wsteth, mellowVault, weth, feeRecipient, unlockTime);
  }

  function allVaultsLength() external view returns (uint256) { return allVaults.length; }
  function ownerVaultsLength(address owner_) external view returns (uint256) { return vaultsByOwner[owner_].length; }
}
