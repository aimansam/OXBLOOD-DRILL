import { Html, OrbitControls, Stars } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Asset, Network } from './types';

type PositionedAsset = Asset & { position: [number, number, number]; network: string };

const tones = ['#ef646b', '#ecb83f', '#35c6d3', '#5e9dff', '#9d7aea'];

function assetTone(asset: Asset) {
  const state = String(asset.status || '').toLowerCase();
  if (state === 'failed' || asset.error) return '#f04444';
  if (state === 'running') return '#36d399';
  if (/(red|kali|attack)/i.test(asset.role)) return '#ff6677';
  if (/(blue|log|backup|defense)/i.test(asset.role)) return '#64a8ff';
  return '#f0b84a';
}

function makeLayout(assets: Asset[], networks: Network[]): PositionedAsset[] {
  const names = networks.map((network) => network.name).filter(Boolean);
  const fallback = names.length ? names : ['range'];
  const xFor = (name: string) => (fallback.indexOf(name) - (fallback.length - 1) / 2) * 5.3;
  const grouped = new Map<string, Asset[]>();
  assets.forEach((asset) => {
    const network = asset.networks?.[0] || fallback[0];
    grouped.set(network, [...(grouped.get(network) || []), asset]);
  });
  return [...grouped.entries()].flatMap(([network, members]) => members.map((asset, index) => ({
    ...asset,
    network,
    position: [xFor(network), (index - (members.length - 1) / 2) * 2.2, (index % 2 ? 0.7 : -0.7)] as [number, number, number],
  })));
}

function CameraDirector({ focus, resetNonce, controls }: {
  focus?: PositionedAsset;
  resetNonce: number;
  controls: MutableRefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();
  const desired = useRef(new THREE.Vector3(0, 4, 16));
  const target = useRef(new THREE.Vector3());
  useEffect(() => {
    target.current.set(focus ? focus.position[0] : 0, focus ? focus.position[1] : 0, focus ? focus.position[2] : 0);
    desired.current.set(target.current.x, target.current.y + 4, target.current.z + 16);
  }, [focus, resetNonce]);
  useFrame(() => {
    camera.position.lerp(desired.current, 0.045);
    if (controls.current) {
      controls.current.target.lerp(target.current, 0.06);
      controls.current.update();
    }
  });
  return null;
}

function NetworkZone({ network, index, total }: { network: Network; index: number; total: number }) {
  const x = (index - (total - 1) / 2) * 5.3;
  const color = tones[index % tones.length];
  return <group position={[x, 0, -0.35]}>
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[4.4, 8.4]} />
      <meshBasicMaterial color={color} transparent opacity={0.045} side={THREE.DoubleSide} />
    </mesh>
    <lineSegments>
      <edgesGeometry args={[new THREE.PlaneGeometry(4.4, 8.4)]} />
      <lineBasicMaterial color={color} transparent opacity={0.46} />
    </lineSegments>
    <Html position={[0, 4.7, 0]} center transform sprite distanceFactor={12} className="range-zone-label">
      <span>{network.name}</span>
      <small>{network.vlan_id ? `VLAN ${network.vlan_id}` : network.cidr || 'NETWORK'}</small>
    </Html>
  </group>;
}

function SignalLink({ from, to, color }: { from: PositionedAsset; to: PositionedAsset; color: string }) {
  const geometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from.position),
      new THREE.Vector3((from.position[0] + to.position[0]) / 2, (from.position[1] + to.position[1]) / 2, 0.35),
      new THREE.Vector3(...to.position),
    ]);
  }, [from, to]);
  const material = useMemo(() => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }), [color]);
  const line = useMemo(() => new THREE.Line(geometry, material), [geometry, material]);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useFrame((state) => { material.opacity = 0.34 + Math.sin(state.clock.elapsedTime * 2.2 + from.id) * 0.18; });
  return <primitive object={line} />;
}

function Machine({ asset, selected, onSelect }: { asset: PositionedAsset; selected: boolean; onSelect: (asset: PositionedAsset) => void }) {
  const group = useRef<THREE.Group>(null);
  const color = assetTone(asset);
  useFrame((state) => {
    if (!group.current) return;
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 2.2 + asset.position[1]) * 0.045;
    group.current.scale.setScalar(selected ? pulse * 1.22 : pulse);
    group.current.rotation.z += 0.002;
  });
  return <group ref={group} position={asset.position} onClick={(event) => { event.stopPropagation(); onSelect(asset); }}>
    <mesh>
      <octahedronGeometry args={[0.57, 1]} />
      <meshStandardMaterial color="#101a25" emissive={color} emissiveIntensity={selected ? 1.2 : 0.46} roughness={0.32} metalness={0.72} />
    </mesh>
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.92, 0.025, 8, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.82} />
    </mesh>
    <pointLight color={color} intensity={selected ? 2 : 0.8} distance={4} />
    <Html position={[0, -1.15, 0]} center transform sprite distanceFactor={12} className="range-node-label">
      <strong>{asset.role.replace(/_/g, ' ')}</strong>
      <small>{String(asset.status || 'planned').toUpperCase()}</small>
    </Html>
  </group>;
}

function Scene({ assets, networks, selected, onSelect, resetNonce }: {
  assets: Asset[]; networks: Network[]; selected?: Asset; onSelect: (asset: Asset | undefined) => void; resetNonce: number;
}) {
  const layout = useMemo(() => makeLayout(assets, networks), [assets, networks]);
  const selectedNode = layout.find((asset) => asset.id === selected?.id);
  const links = useMemo(() => layout.slice(1).map((asset, index) => [layout[index], asset] as const), [layout]);
  const zones = networks.length ? networks : [{ name: 'range' }];
  const controls = useRef<OrbitControlsImpl | null>(null);
  return <Canvas camera={{ position: [0, 4, 16], fov: 47 }} dpr={[1, 1.75]} onPointerMissed={() => onSelect(undefined)}>
    <color attach="background" args={['#060a10']} />
    <fog attach="fog" args={['#060a10', 11, 29]} />
    <ambientLight intensity={0.62} />
    <directionalLight position={[3, 8, 6]} intensity={1.2} color="#a5d8ff" />
    <pointLight position={[-8, -2, 2]} intensity={1.4} color="#db344a" />
    <Stars radius={40} depth={18} count={800} factor={2} saturation={0} fade speed={0.25} />
    <gridHelper args={[30, 30, '#172d40', '#0c1623']} position={[0, -3.2, -0.5]} />
    {zones.map((network, index) => <NetworkZone key={network.name} network={network} index={index} total={zones.length} />)}
    {links.map(([from, to], index) => <SignalLink key={`${from.id}-${to.id}`} from={from} to={to} color={index % 2 ? '#55b8ff' : '#ef646b'} />)}
    {layout.map((asset) => <Machine key={asset.id} asset={asset} selected={asset.id === selected?.id} onSelect={onSelect} />)}
    <CameraDirector focus={selectedNode} resetNonce={resetNonce} controls={controls} />
    <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.075} minDistance={5} maxDistance={30} maxPolarAngle={Math.PI * 0.69} />
  </Canvas>;
}

export function RangeScene(props: { assets: Asset[]; networks: Network[]; selected?: Asset; onSelect: (asset?: Asset) => void; resetNonce: number }) {
  return <Scene {...props} />;
}
