"use client";

import React, { useEffect, useRef } from "react";

type FridayOrbVisualProps = {
  state?: "standby" | "listening" | "thinking" | "speaking" | "completed";
  isListening?: boolean;
};

const VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjection;
uniform float uTime;
uniform float uSpeed;
varying vec3 vNormal;
varying vec3 vPosition;
varying float vNoise;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
 const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
 vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
 vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
 vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
 i=mod289(i); vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
 vec4 j=p-49.0*floor(p*(1.0/49.0)); vec4 x_=floor(j*(1.0/7.0)); vec4 y_=floor(j-7.0*x_);
 vec4 x=x_*(2.0/7.0)-13.0/14.0; vec4 y=y_*(2.0/7.0)-13.0/14.0;
 vec4 h=1.0-abs(x)-abs(y); vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
 vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
 vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
 vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
 vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
 p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
 vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
 return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
void main(){
 float t=uTime*uSpeed;
 float n=snoise(aPosition*2.45+vec3(t*.13,t*.09,-t*.11));
 float n2=snoise(aPosition*5.0+vec3(-t*.07,t*.1,t*.06));
 float displacement=(n*.025+n2*.008);
 vec3 p=aPosition*(1.0+displacement);
 vNormal=normalize(aPosition+vec3(n*.035));
 vPosition=p;vNoise=n;
 gl_Position=uProjection*vec4(p+vec3(0.0,0.0,-2.8),1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
uniform float uTime;
uniform float uSpeed;
uniform vec2 uResolution;
varying vec3 vNormal;
varying vec3 vPosition;
varying float vNoise;
void main(){
 vec3 N=normalize(vNormal); vec3 V=normalize(vec3(0.0,0.0,2.8)-vPosition);
 float fresnel=pow(1.0-max(dot(N,V),0.0),2.35);
 float t=uTime*uSpeed;
 float flow=sin(vPosition.y*5.0+t*.42+vNoise*2.0)*.5+.5;
 vec3 deep=vec3(.025,.055,.105);
 vec3 cyan=vec3(.28,.88,1.0);
 vec3 violet=vec3(.72,.48,1.0);
 vec3 rose=vec3(1.0,.48,.72);
 float dispersion=pow(fresnel,1.35);
 vec3 spectral=mix(cyan,violet,clamp(.5+.5*sin(atan(N.y,N.x)*2.0+t*.12),0.0,1.0));
 spectral=mix(spectral,rose,clamp(.5+.5*sin(atan(N.z,N.x)*2.7-1.2),0.0,1.0)*.55);
 vec3 col=mix(deep,spectral,dispersion*.88);
 col+=cyan*pow(max(dot(reflect(-V,N),normalize(vec3(-.7,.8,1.0))),0.0),28.0)*.65;
 col+=vec3(.75,.88,1.0)*pow(max(dot(reflect(-V,N),normalize(vec3(.75,.55,1.0))),0.0),65.0)*.85;
 col+=mix(cyan,violet,flow)*(.035+flow*.055)*(1.0-fresnel);
 col+=spectral*pow(fresnel,4.0)*.38;
 float alpha=clamp(.22+fresnel*.72+pow(fresnel,5.0)*.2,0.0,.96);
 gl_FragColor=vec4(col,alpha);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function FridayOrbVisual({ state = "standby", isListening }: FridayOrbVisualProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listening = isListening ?? state === "listening";
  const listeningRef = useRef(listening);
  const [fallback, setFallback] = React.useState(false);
  listeningRef.current = listening;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let gl: WebGLRenderingContext | null = null;
    let raf = 0;
    let program: WebGLProgram | null = null;
    let vertexBuffer: WebGLBuffer | null = null;
    let indexBuffer: WebGLBuffer | null = null;
    let vertexShader: WebGLShader | null = null;
    let fragmentShader: WebGLShader | null = null;
    let disposed = false;
    const start = performance.now();

    const onContextLost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(raf);
      setFallback(true);
    };
    canvas.addEventListener("webglcontextlost", onContextLost, false);

    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
        powerPreference: "low-power",
      });
      if (!gl) throw new Error("WebGL is unavailable");

      vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error("Unable to create WebGL program");
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
      }
      gl.useProgram(program);

      const positions: number[] = [];
      const latitudes = 128;
      const longitudes = 128;
      for (let y = 0; y <= latitudes; y++) {
        const v = y / latitudes;
        const phi = v * Math.PI;
        for (let x = 0; x <= longitudes; x++) {
          const u = x / longitudes;
          const theta = u * Math.PI * 2;
          positions.push(
            -Math.cos(theta) * Math.sin(phi),
            Math.cos(phi),
            Math.sin(theta) * Math.sin(phi),
          );
        }
      }

      const indices: number[] = [];
      for (let y = 0; y < latitudes; y++) {
        for (let x = 0; x < longitudes; x++) {
          const a = y * (longitudes + 1) + x;
          const b = a + longitudes + 1;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }

      const indexData = new Uint16Array(indices);
      vertexBuffer = gl.createBuffer();
      indexBuffer = gl.createBuffer();
      if (!vertexBuffer || !indexBuffer) throw new Error("Unable to create geometry buffers");

      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

      const projection = gl.getUniformLocation(program, "uProjection");
      const time = gl.getUniformLocation(program, "uTime");
      const speed = gl.getUniformLocation(program, "uSpeed");
      const resolution = gl.getUniformLocation(program, "uResolution");
      if (!projection || !time || !speed || !resolution) {
        throw new Error("Required shader uniforms are unavailable");
      }

      const draw = () => {
        if (disposed || !gl || !program) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          gl.viewport(0, 0, width, height);
        }

        const aspect = width / height;
        const f = 1 / Math.tan(Math.PI / 8);
        const near = 0.1;
        const far = 10;
        const matrix = new Float32Array(16);
        matrix[0] = f / Math.max(aspect, 1);
        matrix[5] = f * Math.min(aspect, 1);
        matrix[10] = (far + near) / (near - far);
        matrix[11] = -1;
        matrix[14] = (2 * far * near) / (near - far);

        gl.uniformMatrix4fv(projection, false, matrix);
        gl.uniform1f(time, (performance.now() - start) / 1000);
        gl.uniform1f(speed, listeningRef.current ? 2.65 : 1);
        gl.uniform2f(resolution, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_SHORT, 0);
        raf = requestAnimationFrame(draw);
      };

      setFallback(false);
      draw();
    } catch (error) {
      console.error("[FridayOrbVisual] WebGL initialization failed:", error);
      setFallback(true);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      if (gl) {
        if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
        if (indexBuffer) gl.deleteBuffer(indexBuffer);
        if (program) gl.deleteProgram(program);
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
      }
    };
  }, []);

  return (
    <div className="friday-orb-visual" data-state={state} aria-hidden="true">
      <canvas
        ref={canvasRef}
        className="friday-orb-webgl"
        style={{ display: fallback ? "none" : "block" }}
      />
      {fallback ? (
        <span
          className="friday-orb-fallback"
          style={{
            position: "absolute",
            inset: "8%",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 34% 27%, rgba(255,255,255,.98) 0 3%, rgba(160,239,255,.82) 9%, rgba(105,166,255,.42) 27%, rgba(160,105,255,.34) 48%, rgba(255,132,202,.22) 62%, rgba(22,38,76,.08) 74%, transparent 76%)",
            boxShadow:
              "inset -8px -10px 22px rgba(58,52,122,.2), inset 5px 5px 14px rgba(255,255,255,.72), 0 0 22px rgba(128,180,255,.28)",
            animation: "friday-orb-fallback-breathe 4.2s ease-in-out infinite",
          }}
        />
      ) : null}
      {listening ? <span className="friday-orb-listening">Listening...</span> : null}
      <style jsx global>{`
        @keyframes friday-orb-fallback-breathe {
          0%, 100% { transform: scale(.96); filter: hue-rotate(0deg); }
          50% { transform: scale(1.04); filter: hue-rotate(24deg); }
        }
      `}</style>
    </div>
  );
}
