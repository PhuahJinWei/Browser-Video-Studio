/**
 * Compositor shaders.
 *
 * Kept as TypeScript string exports rather than `.wgsl` files so they need no loader
 * plugin and can interpolate constants shared with the host code.
 */

/** Blend mode ids — must match `BLEND_MODE_IDS` in compositor.ts and the WGSL switch. */
export const WGSL_BLEND = /* wgsl */ `
fn blend_channel(mode: u32, base: f32, src: f32) -> f32 {
  switch mode {
    case 1u: { return base * src; }                                    // multiply
    case 2u: { return base + src - base * src; }                       // screen
    case 3u: {                                                          // overlay
      if (base <= 0.5) { return 2.0 * base * src; }
      return 1.0 - 2.0 * (1.0 - base) * (1.0 - src);
    }
    case 4u: { return min(1.0, base + src); }                          // add
    case 5u: { return min(base, src); }                                // darken
    case 6u: { return max(base, src); }                                // lighten
    case 7u: { return abs(base - src); }                               // difference
    default: { return src; }                                           // normal
  }
}

fn blend_rgb(mode: u32, base: vec3f, src: vec3f) -> vec3f {
  return vec3f(
    blend_channel(mode, base.r, src.r),
    blend_channel(mode, base.g, src.g),
    blend_channel(mode, base.b, src.b),
  );
}
`;

/**
 * Layer composite pass.
 *
 * Draws a full-screen triangle over the sequence canvas. For every output pixel it
 * maps back into the layer's local space (the inverse of the layer transform), so
 * rotation and scaling need no geometry — just a matrix — and sampling stays exact.
 */
export const COMPOSITE_SHADER = /* wgsl */ `
struct LayerUniforms {
  // Inverse transform, packed as two rows of a 2x3 affine matrix.
  inv_row0    : vec4f,   // xy = matrix row 0, zw = translation part
  inv_row1    : vec4f,
  layer_size  : vec2f,   // layer's natural size in pixels
  target_size : vec2f,
  crop        : vec4f,   // left, top, right, bottom as normalised insets
  colour      : vec4f,   // brightness, contrast, saturation, exposure
  opacity     : f32,
  blend_mode  : u32,
  wipe_mode   : u32,   // 0 none, 1 right, 2 left, 3 down, 4 up, 5 iris
  wipe_prog   : f32,   // 0 fully hidden, 1 fully revealed
  wipe_soft   : f32,   // feather width, as a fraction of the sweep
  wipe_hide   : u32,   // 1 inverts the mask, so the edge takes the layer away
  _pad        : vec2f,
};

@group(0) @binding(0) var<uniform> u        : LayerUniforms;
@group(0) @binding(1) var         samp      : sampler;
@group(0) @binding(2) var         layer_tex : texture_2d<f32>;
@group(0) @binding(3) var         base_tex  : texture_2d<f32>;

${WGSL_BLEND}

struct VertexOut {
  @builtin(position) position : vec4f,
  @location(0)       uv       : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index : u32) -> VertexOut {
  // Full-screen triangle: cheaper than a quad and avoids the diagonal seam.
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VertexOut;
  let p = positions[index];
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

/**
 * Reveal mask for a wipe, in target space so a scaled or repositioned clip
 * still wipes across the frame rather than across its own box.
 */
fn wipe_mask(uv : vec2f) -> f32 {
  // How far along the sweep a pixel sits. Lowest values are revealed first.
  var travel = 0.0;
  if (u.wipe_mode == 1u) {
    travel = uv.x;                                   // edge moves right
  } else if (u.wipe_mode == 2u) {
    travel = 1.0 - uv.x;                             // edge moves left
  } else if (u.wipe_mode == 3u) {
    travel = uv.y;                                   // edge moves down
  } else if (u.wipe_mode == 4u) {
    travel = 1.0 - uv.y;                             // edge moves up
  } else {
    // Iris opens from the centre. Distance is measured with the frame's aspect
    // applied, or the circle would come out as an ellipse stretched to the frame;
    // dividing by the corner distance makes full progress just clear the corners.
    let aspect = vec2f(u.target_size.x / max(u.target_size.y, 1.0), 1.0);
    travel = length((uv - vec2f(0.5)) * aspect) / length(vec2f(0.5) * aspect);
  }

  // Run the edge from just before 0 to just past 1 so the feather itself is
  // fully off-screen at both ends — otherwise a wipe starts half-revealed.
  let soft = max(u.wipe_soft, 0.0001);
  let edge = u.wipe_prog * (1.0 + 2.0 * soft) - soft;
  let revealed = 1.0 - smoothstep(edge - soft, edge + soft, travel);
  // Wiping out to black is the same edge going the same way, hiding instead.
  let masked = select(revealed, 1.0 - revealed, u.wipe_hide == 1u);

  // Selected rather than branched, so every layer runs the same control flow.
  return select(masked, 1.0, u.wipe_mode == 0u);
}

fn apply_colour(rgb : vec3f) -> vec3f {
  var c = rgb;
  c = c * pow(2.0, u.colour.w);                       // exposure, in stops
  c = c + vec3f(u.colour.x);                          // brightness
  c = (c - vec3f(0.5)) * (1.0 + u.colour.y) + vec3f(0.5); // contrast about mid grey
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));   // Rec.709 luma
  c = mix(vec3f(luma), c, 1.0 + u.colour.z);          // saturation
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(in : VertexOut) -> @location(0) vec4f {
  let base = textureSample(base_tex, samp, in.uv);
  let pixel = in.uv * u.target_size;

  // Map the output pixel back into layer space.
  let local = vec2f(
    dot(u.inv_row0.xy, pixel) + u.inv_row0.z,
    dot(u.inv_row1.xy, pixel) + u.inv_row1.z,
  );
  let uv = local / u.layer_size;

  // WGSL requires textureSample to be reached in uniform control flow, so the
  // bounds and crop tests become an alpha mask rather than an early return.
  let src = textureSample(layer_tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)));

  let inside_bounds = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let inside_crop =
    uv.x >= u.crop.x && uv.y >= u.crop.y &&
    uv.x <= 1.0 - u.crop.z && uv.y <= 1.0 - u.crop.w;
  let mask = select(0.0, 1.0, inside_bounds && inside_crop);

  let rgb   = apply_colour(src.rgb);
  let alpha = src.a * u.opacity * mask * wipe_mask(in.uv);

  // Standard source-over, with the blend function choosing the source colour.
  let blended = blend_rgb(u.blend_mode, base.rgb, rgb);
  let out_a   = alpha + base.a * (1.0 - alpha);
  let out_rgb = blended * alpha + base.rgb * (1.0 - alpha);
  return vec4f(out_rgb, out_a);
}
`;

/** Separable gaussian blur. Run twice with `direction` flipped. */
export const BLUR_SHADER = /* wgsl */ `
struct BlurUniforms {
  direction   : vec2f,   // (1,0) horizontal, (0,1) vertical
  texel       : vec2f,   // 1 / texture size
  radius      : f32,
  sigma       : f32,
  _pad        : vec2f,
};

@group(0) @binding(0) var<uniform> u    : BlurUniforms;
@group(0) @binding(1) var         samp : sampler;
@group(0) @binding(2) var         src  : texture_2d<f32>;

struct VertexOut {
  @builtin(position) position : vec4f,
  @location(0)       uv       : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index : u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VertexOut;
  let p = positions[index];
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@fragment
fn fs(in : VertexOut) -> @location(0) vec4f {
  // The radius comes from a uniform, so this loop bound is uniform across the
  // draw and textureSample below stays in uniform control flow.
  let steps = i32(clamp(u.radius, 0.0, 64.0));

  // Premultiply while accumulating so transparent edges do not bleed dark haloes.
  var sum    = vec4f(0.0);
  var weight = 0.0;
  let two_sigma_sq = max(2.0 * u.sigma * u.sigma, 0.0001);

  for (var i = -steps; i <= steps; i = i + 1) {
    let offset = f32(i);
    let w = exp(-(offset * offset) / two_sigma_sq);
    let uv = in.uv + u.direction * u.texel * offset;
    let s = textureSample(src, samp, uv);
    sum = sum + vec4f(s.rgb * s.a, s.a) * w;
    weight = weight + w;
  }

  let acc = sum / max(weight, 0.0001);
  return select(vec4f(acc.rgb / max(acc.a, 0.0001), acc.a), vec4f(0.0), acc.a <= 0.0001);
}
`;

/** Final blit of the composite texture onto the presentation surface. */
export const BLIT_SHADER = /* wgsl */ `
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var src  : texture_2d<f32>;

struct VertexOut {
  @builtin(position) position : vec4f,
  @location(0)       uv       : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index : u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VertexOut;
  let p = positions[index];
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@fragment
fn fs(in : VertexOut) -> @location(0) vec4f {
  return textureSample(src, samp, in.uv);
}
`;
