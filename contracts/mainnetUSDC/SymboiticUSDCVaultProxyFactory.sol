// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymbioticUSDCVaultProxy} from "./SymbioticUSDCVaultProxy.sol";

contract SymbioticUSDCVaultProxyFactory {
  address public immutable USDC;
  address public immutable SUSDE;
  address public immutable RS_VAULT; 

  event VaultCreated(
    address indexed owner,
    address indexed operatorFeeRecipient,
    uint64 unlockTime,
    address vault
  );

  constructor(address _usdc, address _susde, address _rsVault) {
    require(_usdc != address(0) && _susde != address(0) && _rsVault != address(0), "ZERO_ADDR");
    USDC = _usdc;
    SUSDE = _susde;
    RS_VAULT = _rsVault;
  }

  function createVault(
    address owner_,
    address operatorFeeRecipient,
    uint64  unlockTime
  ) external returns (address vault) {
    require(owner_ != address(0) && operatorFeeRecipient != address(0), "ZERO_ADDR");

    vault = address(
      new SymbioticUSDCVaultProxy(
        owner_,
        USDC,
        SUSDE,
        RS_VAULT,
        operatorFeeRecipient, 
        unlockTime
      )
    );

    emit VaultCreated(owner_, operatorFeeRecipient, unlockTime, vault);
  }
}
