import { FBXLoader, GLTFLoader, MeshoptDecoder } from "three-stdlib";

export function createModel3DGLTFLoader() {
    // Tripo's geometry compression uses EXT_meshopt_compression.
    return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder());
}

export function createModel3DFBXLoader() { return new FBXLoader(); }
