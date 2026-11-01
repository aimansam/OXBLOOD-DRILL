# react-map

Source for the 3D range view served at `/drill/three/`.

The built bundle is committed in `../app/three/` on purpose: the dev compose
file bind-mounts `apps/portal/app` over the image, so the output must exist on
disk in the repo. After changing anything in `src/`, rebuild and commit it:

    npm ci
    npm run build   # tsc --noEmit && vite build -> ../app/three/
