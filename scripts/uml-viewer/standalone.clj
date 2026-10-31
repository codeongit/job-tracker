(ns job-tracker.uml-viewer
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [uml-viewer.adapters.sketch :as sketch]
            [uml-viewer.application.detail :as detail]
            [uml-viewer.application.document :as document]
            [uml-viewer.application.events :as events]
            [uml-viewer.application.overlay :as overlay]
            [uml-viewer.domain.ir :as ir]
            [uml-viewer.domain.hierarchy :as hierarchy]
            [uml-viewer.domain.log :as log]
            [uml-viewer.typescript-language.graph-typescript :as typescript]
            [uml-viewer.typescript-language.source-typescript :as ts-source]))

(def original-load-document ir/load-document)
(defonce member-cache (atom {}))
(def standalone-message "Standalone viewer: run pnpm uml export; R reloads. Agent actions and proposal edits are disabled.")

(defn upstream-var [namespace name]
  (or (ns-resolve namespace name)
      (throw (ex-info "Pinned uml-viewer integration point is missing"
                      {:namespace namespace :name name}))))

(defn replace-root! [v replacement]
  ;; Quil callbacks run after start! returns, so a temporary with-redefs would
  ;; restore the companion. These bindings belong to this dedicated JVM.
  (alter-var-root v (constantly replacement)))

(def original-box-name (var-get (upstream-var 'uml-viewer.domain.hierarchy 'box-name)))
(def original-module-name (var-get (upstream-var 'uml-viewer.domain.hierarchy 'module-name)))
(def original-external-end (var-get (upstream-var 'uml-viewer.domain.hierarchy 'external-end)))
(def original-module-label (var-get (upstream-var 'uml-viewer.application.detail 'module-label)))
(def original-detail-rows detail/rows)

(def detail-font-context (java.awt.font.FontRenderContext. nil (boolean true) (boolean true)))
(def detail-font
  (delay (processing.core.PFont. (java.awt.Font. "SansSerif" java.awt.Font/PLAIN 14) true)))

(defn- wrap-label [text size width]
  ;; JAVA2D measures the derived native font with fractional metrics. PFont's
  ;; per-character widths can underestimate strings and lose text at the edge.
  (let [font (java.awt.Font. "SansSerif" java.awt.Font/PLAIN size)
        fits? #(<= (.getWidth (.getStringBounds font % detail-font-context)) (- width 1))]
    (mapcat
      (fn [paragraph]
        (loop [points (seq (.toArray (.codePoints ^String paragraph))) line "" lines []]
          (if-let [point (first points)]
            (let [ch (String. (Character/toChars point))
                  candidate (str line ch)]
              (if (or (empty? line) (fits? candidate))
                (recur (next points) candidate lines)
                (recur points "" (conj lines line))))
            (conj lines line))))
      (str/split text #"\n" -1))))

(defn- readable-detail-rows [model]
  (when-let [rows (original-detail-rows model)]
    (let [columns (detail/column-layout)
          right (if (seq columns) (- (:left (first columns)) detail/col-gap)
                    (- detail/width detail/pad))]
      (:rows
        (reduce
          (fn [{:keys [rows offset]} row]
            (let [size (if (= :name (:kind row)) 20 13)
                  lines (when (:text row)
                          (wrap-label (:text row) size (- right detail/pad)))
                  ;; Match pinned Processing's default leading using the same
                  ;; font as detail-setup; logical fonts vary across platforms.
                  line-h (long (Math/ceil (* size 1.275
                                            (+ (.ascent @detail-font) (.descent @detail-font)))))
                  h (max (:h row) (* (count lines) line-h))
                  laid-out (cond-> (assoc row :y (+ (:y row) offset) :h h)
                             lines (assoc :text (str/join "\n" lines)))]
              {:rows (conj rows laid-out) :offset (+ offset (- h (:h row)))}))
          {:rows [] :offset 0} rows)))))

(defn- file-label [class]
  (when (and (:file class) (not (:drill? class)))
    (.getName (io/file (:file class)))))

(defn- install-display! []
  ;; Encoded IDs delimit the hierarchy. Use file metadata for labels without
  ;; changing IDs/namespaces or decoding literal percent signs in filenames.
  (replace-root! (upstream-var 'uml-viewer.domain.hierarchy 'box-name)
                 (fn [leaf id directory?]
                   (or (when-not directory? (file-label leaf))
                       (original-box-name leaf id directory?))))
  (replace-root! (upstream-var 'uml-viewer.domain.hierarchy 'module-name)
                 (fn [class] (or (file-label class) (original-module-name class))))
  (replace-root! (upstream-var 'uml-viewer.domain.hierarchy 'external-end)
                 (fn [id path index]
                   (let [endpoint (original-external-end id path index)]
                     (if-let [label (when (:external endpoint)
                                     (file-label (get index (:id endpoint))))]
                       (assoc endpoint :name label)
                       endpoint))))
  (replace-root! (upstream-var 'uml-viewer.application.detail 'module-label)
                 (fn [model] (or (file-label (:class model)) (original-module-label model))))
  ;; Drawing, hit testing and scrolling all consume these same row bounds.
  (replace-root! #'detail/rows readable-detail-rows))

(defn prohibited [& _]
  (throw (ex-info "External agent action is disabled in the standalone viewer" {})))

(defn disabled-state [state & _]
  (assoc state :mail-status standalone-message))

(defn show-disabled! [& _]
  (javax.swing.JOptionPane/showMessageDialog nil standalone-message))

(defn- enrich-class [class]
  (if (or (:foreign class) (nil? (:file class)))
    class
    (let [file (:file class)
          text (slurp file)
          cached (get @member-cache file)
          ops (if (= text (:source cached))
                (:ops cached)
                (let [surface (typescript/read-module text)
                      names (distinct (mapcat :ops (:exports surface)))
                      ops (mapv (fn [name] {:name name :text name}) names)]
                  ;; Upstream's parser is expensive on large modules. Compare
                  ;; full contents so R reload stays correct even when file
                  ;; timestamps and sizes have not changed.
                  (swap! member-cache assoc file {:source text :ops ops})
                  ops))]
      (assoc class :ops ops))))

(defn load-document [path]
  ;; The Node exporter owns modules and dependency edges. Only member labels
  ;; use upstream's native parser; no upstream directory scanner runs here.
  (let [doc (original-load-document path)]
    (when-not (:hierarchical doc)
      (throw (ex-info "Expected a generated hierarchical diagram" {})))
    (when (:policy-file doc)
      (throw (ex-info "Standalone diagrams cannot reference a writable policy" {})))
    (let [enriched (update doc :classes #(mapv enrich-class %))]
      (swap! member-cache select-keys (keep :file (:classes doc)))
      enriched)))

(defn install-standalone! [path]
  (install-display!)
  (let [root (.getCanonicalPath (.getParentFile (io/file path)))
        no-action (fn [& _] nil)]
    (doseq [v [#'sketch/open-in-terminal! #'sketch/shutdown-children!
               (upstream-var 'uml-viewer.adapters.sketch 'remember-companion!)]]
      (replace-root! v no-action))
    (doseq [v [#'sketch/tmux! #'sketch/run-osascript #'sketch/notify-agent!]]
      (replace-root! v prohibited))
    (replace-root! #'sketch/request-agent!
                   (fn [& _] {:woke? false :disabled? true}))
    (replace-root! (upstream-var 'uml-viewer.adapters.sketch 'regen-press) disabled-state)
    (replace-root! (upstream-var 'uml-viewer.adapters.sketch 'popup-element-menu!)
                   (fn [& args] (apply show-disabled! args)))
    (replace-root! (upstream-var 'uml-viewer.adapters.sketch 'popup-proposal-menu!)
                   (fn [& args] (apply show-disabled! args)))
    (replace-root! #'document/poll-mail identity)
    (replace-root! #'document/save-session! identity)
    (replace-root! #'document/write-proposals! prohibited)
    (doseq [v [#'events/add-proposal #'events/rename-proposal #'events/delete-proposal]]
      (replace-root! v disabled-state))
    (replace-root! #'document/waiting-state
                   (fn ([p] (document/load-path p))
                       ([p _] (document/load-path p))))
    (replace-root! #'overlay/metrics-root (constantly root))
    (replace-root! #'ir/load-document load-document)
    ;; Do not discover, consume, write or resume a mailbox left by another run.
    (doseq [[name replacement]
            {'read-command no-action
             'read-mailbox (fn [& _] {:next-id 1 :queue []})
             'last-id (constantly 0)
             'read-session no-action
             'read-companion no-action
             'take-command! no-action
             'write-command! prohibited
             'write-session! prohibited
             'write-companion! prohibited
             'atomic-write! prohibited}]
      (replace-root! (upstream-var 'uml-viewer.domain.mailbox name) replacement))
    root))

(defn open! [path]
  (install-standalone! path)
  (let [state (document/load-path path)]
    (when (:error state)
      (throw (ex-info (:error state) {:path path}))))
  (println standalone-message)
  (sketch/start! path ts-source/impl false))

(defn -main [& args]
  (let [[command path & extra] args]
    (when (or extra (not (#{"open" "check"} command)) (nil? path))
      (throw (ex-info "Usage: job-tracker.uml-viewer open|check /absolute/diagram.edn" {})))
    (log/install-exception-log!)
    (case command
      "open" (open! path)
      "check" (if-let [check (resolve 'job-tracker.uml-viewer-check/check!)]
                (check path)
                (throw (ex-info "Load standalone-check.clj before the check command" {}))))))
