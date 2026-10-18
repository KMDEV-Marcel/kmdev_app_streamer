// SFU (Selective Forwarding Unit) fuer den Server-Modus.
//
// Der Host baut genau eine WebRTC-Verbindung zum Server auf ("sfu" ist fuer
// ihn ein normaler Zuschauer). Der Server leitet die empfangenen RTP-Pakete
// unveraendert an alle Zuschauer weiter - kein Umkodieren, daher wenig CPU.
// Fuer die Zuschauer ist "sfu" der Host: Er schickt ihnen das Angebot (Offer).
//
// Jeder Raum hat eine eigene Ereignisschleife (ops), in der alle Aenderungen
// am Raum nacheinander laufen. pion-Callbacks reihen sich dort nur ein.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

type sfuConfig struct {
	Enabled bool   `json:"enabled"`
	UDPPort int    `json:"udpPort"`
	Secret  string `json:"secret"`
}

func (c *sfuConfig) applyDefaults() {
	if c.UDPPort == 0 {
		c.UDPPort = 3479
	}
}

type sfu struct {
	api *webrtc.API

	mu     sync.Mutex
	rooms  map[string]*room
	sender func(ctrlMsg)
}

func newSFU(cfg sfuConfig, publicIP net.IP) (*sfu, error) {
	if len(cfg.Secret) < 16 {
		return nil, fmt.Errorf("sfu.secret fehlt oder ist zu kurz (mind. 16 Zeichen)")
	}
	addr := "0.0.0.0:" + strconv.Itoa(cfg.UDPPort)

	// Alle Verbindungen teilen sich einen UDP- und einen TCP-Port, damit in
	// der Firewall nur dieser eine Port offen sein muss.
	udpConn, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return nil, fmt.Errorf("SFU UDP %s: %w", addr, err)
	}
	tcpListener, err := net.Listen("tcp4", addr)
	if err != nil {
		return nil, fmt.Errorf("SFU TCP %s: %w", addr, err)
	}

	se := webrtc.SettingEngine{}
	se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, udpConn))
	se.SetICETCPMux(webrtc.NewICETCPMux(nil, tcpListener, 32))
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	// Nur die oeffentliche IP anbieten, keine internen Adressen des Servers.
	if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
		External:        []string{publicIP.String()},
		AsCandidateType: webrtc.ICECandidateTypeHost,
	}); err != nil {
		return nil, err
	}

	m := &webrtc.MediaEngine{}
	if err := registerCodecs(m); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	// NACK (Neusenden verlorener Pakete), RTCP-Berichte und TWCC, damit der
	// Encoder des Hosts seine Bitrate an die Leitung zum Server anpasst.
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}

	log.Printf("SFU laeuft auf %s (UDP+TCP), oeffentlich %s", addr, publicIP)
	return &sfu{
		api:   webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir)),
		rooms: map[string]*room{},
	}, nil
}

// Dieselben Codecs wie Chromium, damit die Wahl des Hosts (H.264/VP9/AV1/VP8)
// unveraendert bei den Zuschauern ankommt.
func registerCodecs(m *webrtc.MediaEngine) error {
	fb := []webrtc.RTCPFeedback{
		{Type: "goog-remb"}, {Type: "transport-cc"}, {Type: "ccm", Parameter: "fir"},
		{Type: "nack"}, {Type: "nack", Parameter: "pli"},
	}
	video := []webrtc.RTPCodecParameters{
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", RTCPFeedback: fb}, PayloadType: 102},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", RTCPFeedback: fb}, PayloadType: 104},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f", RTCPFeedback: fb}, PayloadType: 106},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f", RTCPFeedback: fb}, PayloadType: 108},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP9, ClockRate: 90000,
			SDPFmtpLine: "profile-id=0", RTCPFeedback: fb}, PayloadType: 98},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeAV1, ClockRate: 90000,
			RTCPFeedback: fb}, PayloadType: 45},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
			RTCPFeedback: fb}, PayloadType: 96},
	}
	for _, c := range video {
		if err := m.RegisterCodec(c, webrtc.RTPCodecTypeVideo); err != nil {
			return err
		}
	}
	return m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1"},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio)
}

func (s *sfu) setSender(f func(ctrlMsg)) {
	s.mu.Lock()
	s.sender = f
	s.mu.Unlock()
}

// Nachricht an einen Teilnehmer (ueber den Signaling-Server).
func (s *sfu) signal(roomID, peer string, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		return
	}
	s.mu.Lock()
	f := s.sender
	s.mu.Unlock()
	if f != nil {
		f(ctrlMsg{Type: "signal", Room: roomID, Peer: peer, Data: raw})
	}
}

func (s *sfu) handle(m ctrlMsg) {
	if m.Room == "" {
		return
	}
	s.mu.Lock()
	r := s.rooms[m.Room]
	if r == nil && m.Type != "room-close" && m.Type != "peer-leave" {
		r = newRoom(s, m.Room)
		s.rooms[m.Room] = r
	}
	s.mu.Unlock()
	if r == nil {
		return
	}
	switch m.Type {
	case "signal":
		var d signalData
		if json.Unmarshal(m.Data, &d) != nil {
			return
		}
		if m.Role == "host" {
			r.do(func() { r.hostSignal(m.Peer, d) })
		} else {
			r.do(func() { r.viewerSignal(m.Peer, d) })
		}
	case "viewer-join":
		r.do(func() { r.addViewer(m.Peer) })
	case "peer-leave":
		r.do(func() { r.removePeer(m.Peer) })
	case "room-close":
		s.closeRoom(m.Room)
	}
}

func (s *sfu) closeRoom(id string) {
	s.mu.Lock()
	r := s.rooms[id]
	delete(s.rooms, id)
	s.mu.Unlock()
	if r != nil {
		r.do(r.close)
	}
}

func (s *sfu) closeAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.rooms))
	for id := range s.rooms {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.closeRoom(id)
	}
}

/* ---------- Raum ---------- */

type signalData struct {
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
}

type pubTrack struct {
	local   *webrtc.TrackLocalStaticRTP
	codec   webrtc.RTPCodecParameters
	ssrc    webrtc.SSRC
	isVideo bool
	lastPLI time.Time
}

type peerConn struct {
	id        string
	pc        *webrtc.PeerConnection
	remoteSet bool
	pending   []webrtc.ICECandidateInit
}

type viewer struct {
	peerConn
	senders map[*pubTrack]*webrtc.RTPSender
	again   bool // waehrend laufender Verhandlung kam eine Aenderung -> danach neu anbieten
}

type room struct {
	s       *sfu
	id      string
	ops     chan func()
	done    chan struct{}
	host    *peerConn
	tracks  []*pubTrack
	viewers map[string]*viewer
}

func newRoom(s *sfu, id string) *room {
	r := &room{s: s, id: id, ops: make(chan func(), 1024), done: make(chan struct{}), viewers: map[string]*viewer{}}
	go func() {
		for {
			select {
			case f := <-r.ops:
				f()
			case <-r.done:
				return
			}
		}
	}()
	return r
}

// Arbeit in die Ereignisschleife des Raums einreihen (blockiert nie).
func (r *room) do(f func()) {
	select {
	case <-r.done:
	case r.ops <- f:
	default:
		go func() {
			select {
			case r.ops <- f:
			case <-r.done:
			}
		}()
	}
}

func (r *room) close() {
	if r.host != nil {
		r.host.pc.Close()
		r.host = nil
	}
	for id, v := range r.viewers {
		v.pc.Close()
		delete(r.viewers, id)
	}
	r.tracks = nil
	select {
	case <-r.done:
	default:
		close(r.done)
	}
}

func (r *room) newPC(peer string) (*webrtc.PeerConnection, error) {
	pc, err := r.s.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			r.s.signal(r.id, peer, map[string]any{"candidate": c.ToJSON()})
		}
	})
	return pc, nil
}

func (p *peerConn) addCandidate(c webrtc.ICECandidateInit) {
	if p.remoteSet {
		_ = p.pc.AddICECandidate(c)
	} else {
		p.pending = append(p.pending, c)
	}
}

func (p *peerConn) flushCandidates() {
	p.remoteSet = true
	for _, c := range p.pending {
		_ = p.pc.AddICECandidate(c)
	}
	p.pending = nil
}

/* ---------- Host (sendet) ---------- */

func (r *room) hostSignal(peer string, d signalData) {
	if d.SDP != nil && d.SDP.Type == webrtc.SDPTypeOffer {
		if r.host == nil || r.host.id != peer {
			if r.host != nil {
				r.host.pc.Close()
			}
			pc, err := r.newPC(peer)
			if err != nil {
				log.Printf("Raum %s: %v", r.id, err)
				return
			}
			r.host = &peerConn{id: peer, pc: pc}
			pc.OnTrack(func(remote *webrtc.TrackRemote, recv *webrtc.RTPReceiver) {
				r.onHostTrack(pc, remote, recv)
			})
			pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
				log.Printf("Raum %s: Host %s", r.id, st)
			})
		}
		h := r.host
		if err := h.pc.SetRemoteDescription(*d.SDP); err != nil {
			log.Printf("Raum %s: Host-Offer: %v", r.id, err)
			return
		}
		h.flushCandidates()
		answer, err := h.pc.CreateAnswer(nil)
		if err != nil {
			log.Printf("Raum %s: Answer: %v", r.id, err)
			return
		}
		if err := h.pc.SetLocalDescription(answer); err != nil {
			log.Printf("Raum %s: Answer setzen: %v", r.id, err)
			return
		}
		r.s.signal(r.id, peer, map[string]any{"sdp": h.pc.LocalDescription()})
	} else if d.Candidate != nil && r.host != nil && r.host.id == peer {
		r.host.addCandidate(*d.Candidate)
	}
}

// Neue Spur vom Host: an alle Zuschauer weiterreichen.
func (r *room) onHostTrack(pc *webrtc.PeerConnection, remote *webrtc.TrackRemote, recv *webrtc.RTPReceiver) {
	codec := remote.Codec()
	local, err := webrtc.NewTrackLocalStaticRTP(codec.RTPCodecCapability, remote.Kind().String(), "kmdev-stream")
	if err != nil {
		log.Printf("Raum %s: Spur: %v", r.id, err)
		return
	}
	t := &pubTrack{local: local, codec: codec, ssrc: remote.SSRC(), isVideo: remote.Kind() == webrtc.RTPCodecTypeVideo}
	log.Printf("Raum %s: %s-Spur vom Host (%s)", r.id, remote.Kind(), codec.MimeType)

	r.do(func() {
		r.tracks = append(r.tracks, t)
		for _, v := range r.viewers {
			r.attach(v, t)
			r.negotiate(v)
		}
	})

	// RTCP des Empfaengers lesen, damit die Interceptoren (NACK, Berichte) laufen.
	go func() {
		for {
			if _, _, err := recv.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	// Pakete 1:1 weiterleiten. WriteRTP setzt pro Zuschauer SSRC und Payload-Typ.
	go func() {
		defer r.do(func() { r.dropTrack(t) })
		for {
			pkt, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			_ = local.WriteRTP(pkt)
		}
	}()
}

// Keyframe beim Host anfordern (neuer Zuschauer oder Paketverlust beim Zuschauer).
func (r *room) requestKeyframe() {
	if r.host == nil {
		return
	}
	for _, t := range r.tracks {
		if !t.isVideo || time.Since(t.lastPLI) < 500*time.Millisecond {
			continue
		}
		t.lastPLI = time.Now()
		_ = r.host.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(t.ssrc)}})
	}
}

func (r *room) dropTrack(t *pubTrack) {
	for i, x := range r.tracks {
		if x == t {
			r.tracks = append(r.tracks[:i], r.tracks[i+1:]...)
			break
		}
	}
	for _, v := range r.viewers {
		if snd := v.senders[t]; snd != nil {
			_ = v.pc.RemoveTrack(snd)
			delete(v.senders, t)
			r.negotiate(v)
		}
	}
}

/* ---------- Zuschauer (empfangen) ---------- */

func (r *room) addViewer(peer string) {
	if old := r.viewers[peer]; old != nil {
		old.pc.Close()
	}
	pc, err := r.newPC(peer)
	if err != nil {
		log.Printf("Raum %s: %v", r.id, err)
		return
	}
	v := &viewer{peerConn: peerConn{id: peer, pc: pc}, senders: map[*pubTrack]*webrtc.RTPSender{}}
	r.viewers[peer] = v
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			r.do(r.requestKeyframe)
		}
	})
	for _, t := range r.tracks {
		r.attach(v, t)
	}
	// Ohne Spuren gibt es noch nichts anzubieten; das Angebot folgt, sobald
	// der Host sendet (onHostTrack).
	if len(v.senders) > 0 {
		r.negotiate(v)
	}
}

func (r *room) attach(v *viewer, t *pubTrack) {
	tr, err := v.pc.AddTransceiverFromTrack(t.local, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		log.Printf("Raum %s: Spur an Zuschauer: %v", r.id, err)
		return
	}
	// Nur den Codec des Hosts anbieten - umkodiert wird nicht.
	_ = tr.SetCodecPreferences([]webrtc.RTPCodecParameters{t.codec})
	snd := tr.Sender()
	v.senders[t] = snd
	// RTCP vom Zuschauer: PLI/FIR heisst "Bild kaputt" -> Keyframe beim Host holen.
	go func() {
		for {
			pkts, _, err := snd.ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range pkts {
				switch p.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					r.do(r.requestKeyframe)
				}
			}
		}
	}()
}

func (r *room) negotiate(v *viewer) {
	if v.pc.SignalingState() != webrtc.SignalingStateStable {
		v.again = true
		return
	}
	v.again = false
	offer, err := v.pc.CreateOffer(nil)
	if err != nil {
		log.Printf("Raum %s: Offer: %v", r.id, err)
		return
	}
	if err := v.pc.SetLocalDescription(offer); err != nil {
		log.Printf("Raum %s: Offer setzen: %v", r.id, err)
		return
	}
	r.s.signal(r.id, v.id, map[string]any{"sdp": v.pc.LocalDescription()})
}

func (r *room) viewerSignal(peer string, d signalData) {
	v := r.viewers[peer]
	if v == nil {
		return
	}
	if d.SDP != nil && d.SDP.Type == webrtc.SDPTypeAnswer {
		if err := v.pc.SetRemoteDescription(*d.SDP); err != nil {
			log.Printf("Raum %s: Zuschauer-Answer: %v", r.id, err)
			return
		}
		v.flushCandidates()
		if v.again {
			r.negotiate(v)
		}
	} else if d.Candidate != nil {
		v.addCandidate(*d.Candidate)
	}
}

func (r *room) removePeer(peer string) {
	if r.host != nil && r.host.id == peer {
		r.s.closeRoom(r.id)
		return
	}
	if v := r.viewers[peer]; v != nil {
		v.pc.Close()
		delete(r.viewers, peer)
	}
}
