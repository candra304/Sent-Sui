const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519');
const { getFullnodeUrl, SuiClient } = require('@mysten/sui.js/client');
const { TransactionBlock } = require('@mysten/sui.js/transactions');
const { decodeSuiPrivateKey } = require('@mysten/sui.js/cryptography');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

require('dotenv').config();

const SUI_RPC_URL = process.env.SUI_RPC_URL || getFullnodeUrl('testnet');
const DELAY_MS = 2000; // jeda antar wallet (2 detik)

const SYMBOLS = {
  info: '📌', success: '✅', error: '❌', warning: '⚠️', processing: '🔄', wallet: '👛',
  divider: '═════════════════════════════════════════'
};

const logger = {
  info: (msg) => console.log(`${SYMBOLS.info} ${msg}`),
  success: (msg) => console.log(`${SYMBOLS.success} ${msg}`),
  error: (msg) => console.log(`${SYMBOLS.error} ${msg}`),
  warning: (msg) => console.log(`${SYMBOLS.warning} ${msg}`),
  processing: (msg) => console.log(`${SYMBOLS.processing} ${msg}`),
  wallet: (msg) => console.log(`${SYMBOLS.wallet} ${msg}`),
  divider: () => console.log(SYMBOLS.divider),
  result: (key, val) => console.log(`   ${key.padEnd(15)}: ${val}`)
};

class SuiTransferBot {
  constructor(keyInput) {
    this.client = new SuiClient({ url: SUI_RPC_URL });
    this.keypair = this.initializeKeypair(keyInput);
    this.address = this.keypair.getPublicKey().toSuiAddress();
  }

  initializeKeypair(keyInput) {
    try {
      if (keyInput.startsWith('suiprivkey')) {
        const { secretKey } = decodeSuiPrivateKey(keyInput);
        return Ed25519Keypair.fromSecretKey(secretKey);
      } else if (keyInput.startsWith('0x') || /^[0-9a-fA-F]{64}$/.test(keyInput)) {
        const privateKeyBytes = Buffer.from(keyInput.replace(/^0x/, ''), 'hex');
        return Ed25519Keypair.fromSecretKey(privateKeyBytes);
      } else if (/^[A-Za-z0-9+/=]+$/.test(keyInput) && keyInput.length === 44) {
        const privateKeyBytes = Buffer.from(keyInput, 'base64');
        return Ed25519Keypair.fromSecretKey(privateKeyBytes);
      } else {
        return Ed25519Keypair.deriveKeypair(keyInput);
      }
    } catch (err) {
      throw new Error(`Invalid key: ${err.message}`);
    }
  }

  async getBalance() {
    const coins = await this.client.getCoins({ owner: this.address });
    return coins.data.reduce((sum, coin) => sum + BigInt(coin.balance), BigInt(0));
  }

  async transferSui(recipient, amount) {
    const txb = new TransactionBlock();
    const [coin] = txb.splitCoins(txb.gas, [txb.pure(amount * 10**9)]);
    txb.transferObjects([coin], txb.pure(recipient));
    txb.setGasBudget(10000000);
    const result = await this.client.signAndExecuteTransactionBlock({
      transactionBlock: txb,
      signer: this.keypair,
      options: { showEffects: true },
      requestType: 'WaitForLocalExecution'
    });
    return result;
  }
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function main() {
  console.log('\nSUI MULTI WALLET TRANSFER BOT - AIRDROP INSIDERS');
  logger.divider();

  const pkList = fs.readFileSync('pk.txt', 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 10 && !line.startsWith('#'));

  if (pkList.length === 0) {
    logger.error('pk.txt kosong atau tidak ditemukan.');
    return;
  }

  const receivePath = path.join(__dirname, 'receive.txt');
  let recipients = [];

  const opt = await prompt('Recipient:\n1. Manual\n2. Dari receive.txt\nPilih (1/2): ');
  if (opt === '2') {
    if (!fs.existsSync(receivePath)) {
      logger.error('receive.txt tidak ditemukan.');
      return;
    }
    recipients = fs.readFileSync(receivePath, 'utf8')
      .split('\n')
      .map(a => a.trim())
      .filter(a => a.startsWith('0x'));
    if (recipients.length === 0) {
      logger.error('Tidak ada alamat valid di receive.txt.');
      return;
    }
  } else {
    const r = await prompt('Masukkan alamat wallet tujuan (0x...): ');
    if (!r.startsWith('0x')) {
      logger.error('Alamat tidak valid.');
      return;
    }
    recipients = [r];
  }

  const amountOption = await prompt(`Pilihan jumlah transfer:\n1. Input jumlah tetap\n2. Kirim 99.9% dari saldo\nPilih (1/2): `);
  let amount = 0;
  let usePercentage = false;

  if (amountOption === '1') {
    const amountInput = await prompt(`Masukkan jumlah yang dikirim ke tiap penerima (dalam SUI): `);
    amount = parseFloat(amountInput);
    if (isNaN(amount) || amount <= 0) {
      logger.error('Jumlah tidak valid.');
      return;
    }
  } else if (amountOption === '2') {
    usePercentage = true;
    logger.info('Akan mengirim 99.9% dari saldo setiap wallet');
  } else {
    logger.error('Pilihan tidak valid.');
    return;
  }

  logger.divider();
  logger.info(`Menyiapkan transfer dari ${pkList.length} wallet...`);

  for (let i = 0; i < pkList.length; i++) {
    logger.divider();
    logger.wallet(`Wallet ${i + 1}:`);
    try {
      const bot = new SuiTransferBot(pkList[i]);
      logger.result('Address', bot.address);

      const balanceInMist = await bot.getBalance();
      const balanceSui = Number(balanceInMist) / 1e9;
      logger.result('Balance', balanceSui.toFixed(4) + ' SUI');

      for (const to of recipients) {
        let sendAmount = amount;
        if (usePercentage) {
          // Calculate 99.9% of balance in MIST (1 SUI = 1e9 MIST)
          const sendAmountMist = (balanceInMist * 999n) / 1000n; // 99.9% calculation using integer math
          
          // Leave some for gas (0.1 SUI)
          const minGas = BigInt(0.1 * 1e9);
          if (sendAmountMist <= minGas) {
            logger.warning('Saldo tidak cukup untuk transfer, lewati...');
            continue;
          }
          
          const finalSendAmountMist = sendAmountMist - minGas;
          sendAmount = Number(finalSendAmountMist) / 1e9;
          
          logger.info(`Mengirim 99.9% dari saldo: ${sendAmount.toFixed(4)} SUI`);
        }

        if (balanceInMist < BigInt(sendAmount * 1e9)) {
          logger.warning('Saldo tidak cukup, lewati...');
          continue;
        }
        
        logger.processing(`Mengirim ${sendAmount.toFixed(4)} SUI ke ${to}`);
        const res = await bot.transferSui(to, sendAmount);
        logger.success(`Sukses. TX: ${res.digest}`);
      }
    } catch (err) {
      logger.error(err.message);
    }
    await delay(DELAY_MS);
  }

  logger.divider();
  logger.success('SEMUA TRANSFER SELESAI!');
}

main().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
