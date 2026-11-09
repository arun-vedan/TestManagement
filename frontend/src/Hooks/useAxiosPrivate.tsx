import  axiosPrivate  from "../api/axios";
import { useEffect } from "react";

// TD-12 cleanup (Sprint 1.3): this previously depended on useAuth()/AuthContext
// as a useEffect dependency, but AuthContext is never actually provided
// anywhere in the app (see the corrected finding in the strategy doc, Phase 1
// §5) — useContext(AuthContext) always resolved to null, so that dependency
// never changed and the effect only ever ran once on mount anyway. The real
// auth header is set by api/axios.tsx's own Keycloak-based interceptor;
// this hook's fallback (localStorage 'token', which the live app never sets)
// was already dead in practice. Removing the inert dependency changes nothing
// observable — same axios instance, same interceptor registered once on mount.
const useAxiosPrivate = () => {

    useEffect(() => {

        const requestIntercept = axiosPrivate.interceptors.request.use(
            config => {
                if (!config.headers['Authorization']) {
                    config.headers['Authorization'] = `Bearer ${localStorage.getItem('token')}`;
                }
                return config;
            }, (error) => Promise.reject(error)
        );

        const responseIntercept = axiosPrivate.interceptors.response.use(
            response => response,
        );

        return () => {
            axiosPrivate.interceptors.request.eject(requestIntercept);
            axiosPrivate.interceptors.response.eject(responseIntercept);
        }
    }, [])

    return axiosPrivate;
}

export default useAxiosPrivate;