import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, createWalletClient, custom, fallback, getAddress, http, toHex, type Address, type EIP1193Provider, type PublicClient, type WalletClient, type Transport } from 'viem';
import type { RuntimeConfig } from './config';
import { AppError, errorMessage } from './game';

export type BrowserProvider = EIP1193Provider & { providers?: BrowserProvider[]; on?: (event: string, listener: (...args: any[]) => void) => void; removeListener?: (event: string, listener: (...args: any[]) => void) => void };
declare global { interface Window { ethereum?: BrowserProvider } }
interface DiscoveredWallet { id: string; name: string; provider: BrowserProvider }
export function useWallet(config: RuntimeConfig) {
  const [providers, setProviders] = useState<DiscoveredWallet[]>([]);
  const [provider, setProvider] = useState<BrowserProvider>();
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const connectionLock = useRef(false);
  const providerVersion = useRef(0);
  useEffect(() => {
    const announce = (event: Event) => {
      const { info, provider: p } = (event as CustomEvent<{ info: { uuid: string; name: string }; provider: BrowserProvider }>).detail;
      setProviders(previous => previous.some(w => w.provider === p) ? previous : [...previous, { id: info.uuid, name: info.name, provider: p }]);
    };
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    if (window.ethereum) {
      const detected = window.ethereum.providers ?? [window.ethereum];
      setProviders(previous => [...previous, ...detected.filter(p => !previous.some(w => w.provider === p)).map((p, i) => ({ id: `injected-${i}`, name: detected.length === 1 ? 'Browser wallet' : `Browser wallet ${i + 1}`, provider: p }))]);
      setProvider(detected[0]);
    }
    return () => window.removeEventListener('eip6963:announceProvider', announce);
  }, []);
  useEffect(() => { if (!provider && providers[0]) setProvider(providers[0].provider); }, [provider, providers]);
  useEffect(() => {
    if (!provider) return;
    const version = ++providerVersion.current;
    let active = true;
    let accountsEvent = 0;
    let chainEvent = 0;
    const isCurrent = () => active && version === providerVersion.current;
    const accountsChanged = (accounts: string[]) => { accountsEvent++; if (isCurrent()) setAccount(accounts[0] ? getAddress(accounts[0]) : undefined); };
    const chainChanged = (chain: string) => { chainEvent++; if (isCurrent()) setChainId(Number(BigInt(chain))); };
    const disconnected = () => { if (active) { setAccount(undefined); setChainId(undefined); } };
    void provider.request({ method: 'eth_accounts' }).then(a => { if (accountsEvent === 0) accountsChanged(a as string[]); }).catch(() => {});
    void provider.request({ method: 'eth_chainId' }).then(chain => { if (chainEvent === 0) chainChanged(chain); }).catch(() => {});
    provider.on?.('accountsChanged', accountsChanged); provider.on?.('chainChanged', chainChanged); provider.on?.('disconnect', disconnected);
    return () => { active = false; providerVersion.current++; provider.removeListener?.('accountsChanged', accountsChanged); provider.removeListener?.('chainChanged', chainChanged); provider.removeListener?.('disconnect', disconnected); };
  }, [provider]);
  const connect = useCallback(async () => {
    if (connectionLock.current) return;
    if (!provider) { setError('No browser wallet found. Open this site in an Ethereum wallet browser, or install a browser wallet, then reload.'); return; }
    const version = providerVersion.current;
    connectionLock.current = true; setConnecting(true); setError('');
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const currentChain = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
      if (version !== providerVersion.current) return;
      setAccount(accounts[0] ? getAddress(accounts[0]) : undefined);
      setChainId(currentChain);
    } catch (e) { if (version === providerVersion.current) setError(errorMessage(e)); }
    finally { if (version === providerVersion.current) { connectionLock.current = false; setConnecting(false); } }
  }, [provider]);
  const switchChain = useCallback(async () => {
    if (!provider || connectionLock.current) return;
    const version = providerVersion.current;
    connectionLock.current = true; setConnecting(true); setError('');
    try {
      try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(config.manifest.chainId) }] }); }
      catch (e) {
        const err = e as { code?: number; message?: string; data?: { originalError?: { code?: number } } };
        if (err.code !== 4902 && err.data?.originalError?.code !== 4902 && !/unknown chain|unrecognized chain|chain.*not.*added/i.test(err.message ?? '')) throw e;
        if (!config.manifest.walletAddChain) throw new AppError('The wallet does not know this chain and no approved add-chain settings are available.');
        await provider.request({ method: 'wallet_addEthereumChain', params: [config.manifest.walletAddChain] });
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(config.manifest.chainId) }] });
      }
      const currentChain = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
      if (version === providerVersion.current) setChainId(currentChain);
    } catch (e) { if (version === providerVersion.current) setError(errorMessage(e)); }
    finally { if (version === providerVersion.current) { connectionLock.current = false; setConnecting(false); } }
  }, [provider, config]);
  const publicClient = useMemo(() => {
    const transports: Transport[] = config.network!.rpcUrls.map(url => http(url, { timeout: 8000, retryCount: 0, batch: { wait: 20 } }));
    if (provider && chainId === config.manifest.chainId) transports.push(custom(provider, { retryCount: 0 }));
    return createPublicClient({ chain: config.chain, transport: fallback(transports, { retryCount: 0 }) }) as PublicClient;
  }, [config, provider, chainId]);
  const walletClient = useMemo(() => provider && account ? createWalletClient({ account, chain: config.chain, transport: custom(provider) }) as WalletClient : undefined, [provider, account, config]);
  return { providers, provider, selectProvider: (id: string) => {
    if (connectionLock.current) return;
    const nextProvider = providers.find(p => p.id === id)?.provider;
    if (!nextProvider || nextProvider === provider) return;
    providerVersion.current++; setAccount(undefined); setChainId(undefined); setError(''); setProvider(nextProvider);
  }, account, chainId, connecting, error, connect, switchChain, publicClient, walletClient, disconnect: () => {
    if (connectionLock.current) return;
    setAccount(undefined); setError('');
  } };
}
