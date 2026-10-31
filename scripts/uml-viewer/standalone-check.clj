(ns job-tracker.uml-viewer-check
  (:require [clojure.java.io :as io]
            [quil.core :as q]
            [uml-viewer.adapters.sketch :as sketch]
            [uml-viewer.adapters.source-window :as source-window]
            [uml-viewer.application.detail :as detail]
            [uml-viewer.application.document :as document]
            [uml-viewer.application.events :as events]
            [uml-viewer.domain.hierarchy :as hierarchy]
            [uml-viewer.domain.mailbox :as mailbox]
            [uml-viewer.source :as source]))

(defn ensure! [condition message]
  (when-not condition (throw (ex-info message {}))))

(defn- walk-views! [state]
  (let [doc (:doc state)
        boxes (mapcat :classes (:packages (hierarchy/view-at doc (:focus state))))]
    (ensure! (seq boxes) "A reachable hierarchy view is empty")
    (reduce
      (fn [total box]
        (if-not (:drill? box)
          (update total :modules conj (:id box))
          (let [child (events/drill state (:id box))
                back (events/back child)]
            (ensure! (= (inc (count (:focus state))) (count (:focus child)))
                     "Drill did not advance the hierarchy")
            (ensure! (= (:focus state) (:focus back)) "Back did not restore the parent")
            (let [visited (walk-views! child)]
              (-> total
                  (update :views + (:views visited))
                  (update :modules into (:modules visited)))))))
      {:views 1 :modules #{}} boxes)))

(defn- check-sources! [classes]
  (reduce
    (fn [totals class]
      (if (:foreign class)
        totals
        (let [module (source/member-source (dissoc class :name))
              members (keep #(source/member-source (assoc class :name (:name %)))
                            (:ops class))]
          (ensure! (and module (= (:file class) (:file module)))
                   "A module cannot be opened through the native source adapter")
          (doseq [member members]
            (ensure! (pos-int? (:line member)) "A located member has no source line"))
          (-> totals
              (update :source-files inc)
              (update :located-members + (count members))))))
    {:source-files 0 :located-members 0} classes))

(defn- private-fn [name]
  (var-get (job-tracker.uml-viewer/upstream-var 'uml-viewer.adapters.sketch name)))

(defn- check-member-refresh! []
  (let [dir (.toFile (java.nio.file.Files/createTempDirectory
                      "job-tracker-uml-" (make-array java.nio.file.attribute.FileAttribute 0)))
        file (io/file dir "module.mjs")
        diagram (io/file dir "diagram.edn")
        doc {:hierarchical true :prefix "test" :edges []
             :classes [{:id :module :lang :typescript :file (.getPath file)}]}
        names (fn [] (mapv :name (get-in (job-tracker.uml-viewer/load-document
                                         (.getPath diagram)) [:classes 0 :ops])))]
    (try
      (spit diagram (pr-str doc))
      (spit file "export function first() {}")
      (let [stamp (.lastModified file)]
        (ensure! (= ["first"] (names)) "Native member extraction failed")
        (spit file "export function other() {}")
        (.setLastModified file stamp)
        (ensure! (= ["other"] (names)) "Reload reused stale members after a source edit"))
      (finally
        (.delete diagram)
        (.delete file)
        (.delete dir)))))

(defn- check-card-source! [state]
  (let [class (first (filter :file (get-in state [:doc :classes])))
        model (detail/model (events/card-scene state) (:id class))
        displayed (atom nil)
        display-var (job-tracker.uml-viewer/upstream-var
                      'uml-viewer.adapters.source-window 'show-member-window!)]
    (ensure! model "Module details lost the source identity")
    (with-redefs-fn
      {display-var (fn [title body line] (reset! displayed {:title title :body body :line line}))}
      (fn []
        (ensure! (source-window/open-member-window! nil (detail/member-ident model))
                 "The native module card could not open its source")
        (ensure! (= (:file class) (:title @displayed))
                 "The module card opened a different source file")
        (ensure! (= (slurp (:file class)) (:body @displayed))
                 "The source window did not receive the module contents")))))

(defn- check-callbacks! [path]
  (let [callbacks (atom nil)
        effects (atom [])
        trap (fn [& args]
               (swap! effects conj args)
               (throw (ex-info "Unexpected external process or mailbox operation" {})))
        prohibited-vars [#'sketch/tmux! #'sketch/run-osascript
                         #'mailbox/read-command #'mailbox/read-mailbox #'mailbox/write-command!
                         #'mailbox/read-companion #'mailbox/write-companion!
                         #'mailbox/read-session #'mailbox/write-session!
                         #'mailbox/take-command!]]
    ;; Install the real integration first. Replace bottom-level effects with
    ;; traps afterward so the actual start/setup/update/key/close paths prove
    ;; they never reach an external process or a mailbox.
    (job-tracker.uml-viewer/install-standalone! path)
    (with-redefs-fn
      (merge (zipmap prohibited-vars (repeat trap))
             {#'q/sketch (fn [& opts] (reset! callbacks (apply hash-map opts)))
              #'q/frame-rate (fn [& _]) #'q/color-mode (fn [& _])
              #'q/smooth (fn [& _]) #'q/create-font (fn [& _])
              #'q/text-font (fn [& _]) #'q/width (constantly 1500)
              #'q/height (constantly 920)
              #'job-tracker.uml-viewer/show-disabled! (fn [& _])
              (job-tracker.uml-viewer/upstream-var 'uml-viewer.adapters.sketch 'halt-vm!)
              (fn [])})
      (fn []
        (sketch/start! path nil false)
        (let [state ((:setup @callbacks))
              updated ((:update @callbacks) state)
              requested ((:key-pressed @callbacks) updated {:key :r :key-code 82 :raw-key \r})
              reloaded ((:update @callbacks) requested)
              real (events/on-inspector-press reloaded {:kind :real-diagram})
              proposed (events/on-inspector-press real {:kind :new-proposal})
              renamed (events/rename-proposal proposed :missing "test")
              deleted (events/delete-proposal renamed :missing)]
          (ensure! (:doc state) "Setup did not load the diagram immediately")
          (ensure! (= (:doc state) (:doc deleted)) "Disabled proposal editing changed the document")
          (ensure! (:disabled? (sketch/request-agent! "unused" :regen {}))
                   "Agent request did not return a disabled result")
          ((private-fn 'mail-context!) real)
          ((private-fn 'regen-press) real)
          ((private-fn 'popup-element-menu!) nil 0 0 real nil)
          ((private-fn 'popup-proposal-menu!) nil 0 0 :missing "test")
          ((:on-close @callbacks) state)
          (ensure! (empty? @effects) "A standalone callback reached an external effect"))))
    true))

(defn check! [path]
  (job-tracker.uml-viewer/install-standalone! path)
  (let [started (System/nanoTime)
        state (document/load-path path)
        load-ms (quot (- (System/nanoTime) started) 1000000)
        classes (get-in state [:doc :classes])]
    (ensure! (not (:error state)) (str "Cannot load generated diagram: " (:error state)))
    (ensure! (seq classes) "Generated diagram has no modules")
    (let [source-results (check-sources! classes)
          visited (walk-views! state)]
      (ensure! (= (set (map :id (remove :foreign classes))) (:modules visited))
               "The hierarchy hides one or more generated modules")
      (check-card-source! state)
      (check-callbacks! path)
      (check-member-refresh!)
      (println "uml-viewer headless checks passed")
      (prn (merge {:classes (count classes)
                   :edges (count (get-in state [:doc :edges]))
                   :views (:views visited)
                   :initial-load-ms load-ms
                   :companion-effects 0}
                  source-results)))))
